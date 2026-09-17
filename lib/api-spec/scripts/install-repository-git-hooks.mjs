import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const workspace = process.env.REPOSITORY_HOOKS_WORKSPACE ?? process.cwd();
const repositoryHooksPath = ".githooks";
const chainedConfigKey = "replit.repositoryHooksChained";
const dispatcherConfigKey = "replit.repositoryHooksDispatcher";
const dispatcherHashConfigKey = "replit.repositoryHooksDispatcherHash";
const dispatcherMarker = "# replit-repository-hook-dispatcher";
const preservedHookName = "pre-commit.replit-preserved";
const registrationsDirectoryName = ".replit-repository-hooks";
const dispatcherLockName = ".replit-repository-hooks.lock";
const dispatcherLockTimeoutMilliseconds = 30_000;
const dispatcherLockRetryMilliseconds = 25;
const mode = process.argv[2];

function runGit(args) {
  return spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
  });
}

function hooksDirectory(configuredPath) {
  return isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workspace, configuredPath);
}

function repositoryHookPath() {
  return resolve(workspace, repositoryHooksPath, "pre-commit");
}

function repositoryIdentity() {
  // Worktrees of one repository share a Git common directory, so the
  // per-worktree Git directory identifies each registration independently.
  // For a repository without worktrees the two directories are identical.
  const gitDirectory = runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  if (gitDirectory.status !== 0) {
    process.stderr.write(
      gitDirectory.stderr || "Unable to identify the Git repository.\n",
    );
    process.exit(gitDirectory.status ?? 1);
  }
  return resolve(workspace, gitDirectory.stdout.trim());
}

function registrationName() {
  return `${createHash("sha256").update(repositoryIdentity()).digest("hex")}.sh`;
}

// The previous installer named every worktree's registration from the shared
// Git common directory, which collides with the primary worktree's
// per-worktree name (the primary worktree's Git directory IS the common
// directory).
function legacyRegistrationName() {
  const commonDirectory = runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDirectory.status !== 0) {
    return null;
  }
  return `${createHash("sha256").update(resolve(workspace, commonDirectory.stdout.trim())).digest("hex")}.sh`;
}

function registrationNameFor(worktreeRoot) {
  const gitDirectory = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd: worktreeRoot, encoding: "utf8" },
  );
  if (gitDirectory.status !== 0) {
    return null;
  }
  return `${createHash("sha256").update(resolve(worktreeRoot, gitDirectory.stdout.trim())).digest("hex")}.sh`;
}

// Registrations record the worktree they serve as a shell-quoted
// expected_repository line; anything unreadable never matches.
function registrationTarget(registrationPath) {
  let content;
  try {
    content = readFileSync(registrationPath, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/^expected_repository=(.+)$/m);
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  if (!value.startsWith("'") || !value.endsWith("'")) {
    return null;
  }
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

// Re-attribute a surviving legacy registration to the worktree its content
// actually targets so it neither speaks for the primary worktree nor runs a
// repository hook twice. A registration whose target is gone can never run
// and is removed so it cannot block hook restoration.
function migrateLegacyRegistration(registrationsDirectory) {
  const legacyName = legacyRegistrationName();
  if (legacyName === null) {
    return;
  }
  const legacyPath = join(registrationsDirectory, legacyName);
  if (!existsSync(legacyPath)) {
    return;
  }
  const target = registrationTarget(legacyPath);
  const properName = target === null ? null : registrationNameFor(target);
  if (properName === null) {
    rmSync(legacyPath, { force: true });
    return;
  }
  const properPath = join(registrationsDirectory, properName);
  if (properPath === legacyPath) {
    return;
  }
  if (existsSync(properPath)) {
    rmSync(legacyPath, { force: true });
    return;
  }
  renameSync(legacyPath, properPath);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isManagedDispatcher(path) {
  return (
    existsSync(path) &&
    readFileSync(path, "utf8").startsWith(`#!/bin/sh\n${dispatcherMarker}\n`)
  );
}

function dispatcherContent(registrationsDirectory, preservedPath) {
  return [
    "#!/bin/sh",
    dispatcherMarker,
    "set -u",
    "",
    `registrations=${shellQuote(registrationsDirectory)}`,
    `developer_hook=${shellQuote(preservedPath)}`,
    "",
    "repository_status=0",
    'for registration in "$registrations"/*.sh; do',
    '  [ -e "$registration" ] || continue',
    '  sh "$registration" "$@"',
    "  status=$?",
    '  if [ "$status" -ne 0 ] && [ "$repository_status" -eq 0 ]; then',
    "    repository_status=$status",
    "  fi",
    "done",
    "",
    "developer_status=0",
    `if [ -x "$developer_hook" ]; then`,
    '  "$developer_hook" "$@"',
    "  developer_status=$?",
    "fi",
    "",
    'if [ "$repository_status" -ne 0 ]; then',
    '  exit "$repository_status"',
    "fi",
    'exit "$developer_status"',
    "",
  ].join("\n");
}

function dispatcherHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processStartIdentity(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
    if (fields[21]) {
      return fields[21];
    }
  } catch {
    // macOS has no /proc; use the portable ps start timestamp below.
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) {
    return null;
  }
  const startedAt = result.stdout.trim().replace(/\s+/g, " ");
  return startedAt ? `ps:${startedAt}` : null;
}

function removeStaleDispatcherLock(lockPath) {
  const ownerPath = join(lockPath, "owner");
  let owner;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    return false;
  }
  if (
    typeof owner?.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return false;
  }
  if (processIsRunning(owner.pid)) {
    const currentStartIdentity = processStartIdentity(owner.pid);
    if (
      !owner.startIdentity ||
      !currentStartIdentity ||
      owner.startIdentity === currentStartIdentity
    ) {
      return false;
    }
  }
  const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
    rmSync(quarantinePath, { recursive: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function withDispatcherLock(configuredPath, action) {
  const directory = hooksDirectory(configuredPath);
  const lockPath = join(directory, dispatcherLockName);
  const deadline = Date.now() + dispatcherLockTimeoutMilliseconds;
  const token = randomUUID();
  const candidateLockPath = `${lockPath}-${process.pid}-${token}`;
  mkdirSync(directory, { recursive: true });

  while (true) {
    try {
      mkdirSync(candidateLockPath);
      writeFileSync(
        join(candidateLockPath, "owner"),
        `${JSON.stringify({
          pid: process.pid,
          startIdentity: processStartIdentity(process.pid),
          token,
        })}\n`,
        { flag: "wx" },
      );
      renameSync(candidateLockPath, lockPath);
      break;
    } catch (error) {
      rmSync(candidateLockPath, { recursive: true, force: true });
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
        throw error;
      }
      if (removeStaleDispatcherLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for another hook setup operation to release "${lockPath}".`,
        );
      }
      sleep(dispatcherLockRetryMilliseconds);
    }
  }

  try {
    return action();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, "owner"), "utf8"));
      if (owner?.token === token) {
        const disposalPath = `${lockPath}.released-${token}`;
        renameSync(lockPath, disposalPath);
        rmSync(disposalPath, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be verified.
    }
  }
}

function readGitConfig(key) {
  const result = runGit(["config", "--local", "--get", key]);
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (result.status === 1) {
    return null;
  }
  throw new Error(result.stderr || `Unable to read Git config "${key}".`);
}

function restoreGitConfig(key, value) {
  return value === null
    ? runGit(["config", "--local", "--unset", key])
    : runGit(["config", "--local", key, value]);
}

// Every worktree of a repository shares the local Git config, so dispatcher
// registrations are recorded as multiple values, one per registered worktree.
function readGitConfigValues(key) {
  const result = runGit(["config", "--local", "--get-all", key]);
  if (result.status === 0) {
    return result.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (result.status === 1) {
    return [];
  }
  throw new Error(result.stderr || `Unable to read Git config "${key}".`);
}

function writeGitConfigValues(key, values) {
  const unset = runGit(["config", "--local", "--unset-all", key]);
  if (unset.status !== 0 && unset.status !== 5) {
    return unset;
  }
  let result = { status: 0, stderr: "" };
  for (const value of values) {
    result = runGit(["config", "--local", "--add", key, value]);
    if (result.status !== 0) {
      return result;
    }
  }
  return result;
}

function recordDispatcher(registrationPath, hash) {
  const previousValues = readGitConfigValues(dispatcherConfigKey);
  // Normalize away the legacy boolean marker; only registration paths remain.
  const values = previousValues.filter((value) => value !== "true");
  if (!values.includes(registrationPath)) {
    values.push(registrationPath);
  }
  const record = writeGitConfigValues(dispatcherConfigKey, values);
  if (record.status !== 0) {
    throw new Error(
      record.stderr || "Unable to record the installed hook dispatcher.",
    );
  }
  const recordHash = runGit([
    "config",
    "--local",
    "--replace-all",
    dispatcherHashConfigKey,
    hash,
  ]);
  if (recordHash.status !== 0) {
    writeGitConfigValues(dispatcherConfigKey, previousValues);
    throw new Error(
      recordHash.stderr || "Unable to record the installed hook dispatcher hash.",
    );
  }
}

function installDispatcher(configuredPath) {
  const directory = hooksDirectory(configuredPath);
  const hookPath = join(directory, "pre-commit");
  const preservedPath = join(directory, preservedHookName);
  const registrationsDirectory = join(directory, registrationsDirectoryName);
  const registrationPath = join(registrationsDirectory, registrationName());

  mkdirSync(directory, { recursive: true });
  const dispatcher = dispatcherContent(registrationsDirectory, preservedPath);
  const hash = dispatcherHash(dispatcher);
  const alreadyManaged = isManagedDispatcher(hookPath);
  if (alreadyManaged) {
    if (readFileSync(hookPath, "utf8") !== dispatcher) {
      process.stderr.write(
        `Refusing to install: "${hookPath}" has the managed header but does not match the generated dispatcher.\n`,
      );
      process.exit(1);
    }
  }
  const recoverableInterruptedCopy =
    !alreadyManaged &&
    existsSync(hookPath) &&
    existsSync(preservedPath) &&
    readFileSync(hookPath).equals(readFileSync(preservedPath)) &&
    (statSync(hookPath).mode & 0o777) ===
      (statSync(preservedPath).mode & 0o777);
  if (
    !alreadyManaged &&
    existsSync(preservedPath) &&
    !recoverableInterruptedCopy
  ) {
    process.stderr.write(
      `Refusing to install: "${preservedPath}" already exists. Move or remove it, then retry.\n`,
    );
    process.exit(1);
  }

  const hadDeveloperHook = !alreadyManaged && existsSync(hookPath);
  const createdPreservedHook = hadDeveloperHook && !recoverableInterruptedCopy;
  if (createdPreservedHook) {
    copyFileSync(hookPath, preservedPath, constants.COPYFILE_EXCL);
  }

  const repositoryHook = repositoryHookPath();
  const repositoryRoot = resolve(workspace);
  const registration = [
    "#!/bin/sh",
    "# replit-repository-hook-registration",
    "set -u",
    `expected_repository=${shellQuote(repositoryRoot)}`,
    `repository_hook=${shellQuote(repositoryHook)}`,
    "current_repository=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    '[ "$current_repository" = "$expected_repository" ] || exit 0',
    'exec sh "$repository_hook" "$@"',
    "",
  ].join("\n");

  // Re-attribute any legacy common-directory registration before capturing
  // rollback state, so a reinstall from the matching worktree cannot leave a
  // duplicate registration behind.
  migrateLegacyRegistration(registrationsDirectory);

  const dispatcherTemporaryPath = join(
    directory,
    `.pre-commit.replit-dispatcher-${process.pid}`,
  );
  const registrationTemporaryPath = `${registrationPath}.${process.pid}.tmp`;
  const previousRegistration = existsSync(registrationPath)
    ? {
        content: readFileSync(registrationPath),
        mode: statSync(registrationPath).mode & 0o777,
      }
    : null;
  const previousDispatcherValues = readGitConfigValues(dispatcherConfigKey);
  const previousDispatcherHashRecord = readGitConfig(dispatcherHashConfigKey);
  let installedDispatcher = false;
  try {
    mkdirSync(registrationsDirectory, { recursive: true });
    writeFileSync(registrationTemporaryPath, registration, {
      mode: 0o755,
      flag: "wx",
    });
    chmodSync(registrationTemporaryPath, 0o755);
    renameSync(registrationTemporaryPath, registrationPath);
    if (!alreadyManaged) {
      writeFileSync(dispatcherTemporaryPath, dispatcher, {
        mode: 0o755,
        flag: "wx",
      });
      chmodSync(dispatcherTemporaryPath, 0o755);
      renameSync(dispatcherTemporaryPath, hookPath);
      installedDispatcher = true;
    }
    recordDispatcher(registrationPath, hash);
  } catch (error) {
    rmSync(dispatcherTemporaryPath, { force: true });
    rmSync(registrationTemporaryPath, { force: true });
    let registrationRollbackError = null;
    try {
      if (previousRegistration) {
        writeFileSync(registrationTemporaryPath, previousRegistration.content, {
          mode: previousRegistration.mode,
          flag: "wx",
        });
        chmodSync(registrationTemporaryPath, previousRegistration.mode);
        renameSync(registrationTemporaryPath, registrationPath);
      } else {
        rmSync(registrationPath, { force: true });
      }
    } catch (rollbackError) {
      registrationRollbackError = rollbackError;
    }
    let hookRestoreError = null;
    if (!alreadyManaged && installedDispatcher) {
      if (hadDeveloperHook) {
        try {
          // Replacing the dispatcher directly keeps an active hook at hookPath
          // for the entire rollback. A failed rename leaves both copies intact.
          renameSync(preservedPath, hookPath);
        } catch (restoreError) {
          hookRestoreError = restoreError;
        }
      } else {
        rmSync(hookPath, { force: true });
      }
    } else if (!alreadyManaged && createdPreservedHook) {
      rmSync(preservedPath, { force: true });
    }
    writeGitConfigValues(dispatcherConfigKey, previousDispatcherValues);
    restoreGitConfig(dispatcherHashConfigKey, previousDispatcherHashRecord);
    if (registrationRollbackError || hookRestoreError) {
      const recovery = [
        `Dispatcher installation failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
      if (registrationRollbackError) {
        recovery.push(
          previousRegistration
            ? `Unable to restore the previous repository registration: ${registrationRollbackError instanceof Error ? registrationRollbackError.message : String(registrationRollbackError)}`
            : `Unable to remove the failed repository registration: ${registrationRollbackError instanceof Error ? registrationRollbackError.message : String(registrationRollbackError)}`,
          `A repository registration may remain at "${registrationPath}".`,
          previousRegistration
            ? `The previous registration recovery copy may remain at "${registrationTemporaryPath}". After resolving the filesystem or permission error, restore it manually by moving "${registrationTemporaryPath}" to "${registrationPath}", replacing the failed registration.`
            : `After resolving the filesystem or permission error, remove it manually with: rm -f ${shellQuote(registrationPath)}`,
        );
      }
      if (hookRestoreError) {
        recovery.push(
          `Unable to restore the original pre-commit hook: ${hookRestoreError instanceof Error ? hookRestoreError.message : String(hookRestoreError)}`,
          `The active dispatcher remains at "${hookPath}".`,
          `The original hook remains recoverable at "${preservedPath}".`,
          `After resolving the filesystem or permission error, restore it manually by moving "${preservedPath}" to "${hookPath}", replacing the dispatcher.`,
        );
      } else if (!alreadyManaged && installedDispatcher && hadDeveloperHook) {
        recovery.push(`The original pre-commit hook was restored at "${hookPath}".`);
      }
      recovery.push("");
      process.stderr.write(recovery.join("\n"));
      process.exit(1);
    }
    throw error;
  }

  process.stdout.write(
    [
      `Installed an opt-in pre-commit dispatcher at "${hookPath}".`,
      hadDeveloperHook
        ? `The existing hook was preserved unchanged at "${preservedPath}".`
        : alreadyManaged
          ? "Registered this repository with the existing shared dispatcher."
          : "No existing pre-commit hook was present.",
      "The dispatcher runs the repository check and then the preserved developer hook.",
      `To uninstall and restore the original hook, run "pnpm run hooks:dispatcher:uninstall".`,
      "",
    ].join("\n"),
  );
}

function cleanupDispatcherRecords(
  registrationPath,
  registrationsDirectory,
  { removeDirectory = true, keepSurvivingRecords = false } = {},
) {
  const failures = [];
  try {
    rmSync(registrationPath, { force: true });
  } catch (error) {
    failures.push({
      record: `registration file "${registrationPath}"`,
      command: `rm -f ${shellQuote(registrationPath)}`,
      error,
    });
  }

  if (keepSurvivingRecords) {
    // Only this registration's value leaves the shared multi-valued record;
    // the hash stays until no registered worktree remains in this config.
    // The legacy boolean marker is normalized away as well.
    try {
      const surviving = readGitConfigValues(dispatcherConfigKey).filter(
        (value) => value !== registrationPath && value !== "true",
      );
      const update = writeGitConfigValues(dispatcherConfigKey, surviving);
      if (update.status !== 0) {
        throw new Error(
          update.stderr || `git config exited with status ${update.status}`,
        );
      }
      if (surviving.length === 0) {
        const removeHash = runGit([
          "config",
          "--local",
          "--unset",
          dispatcherHashConfigKey,
        ]);
        if (removeHash.status !== 0 && removeHash.status !== 5) {
          throw new Error(
            removeHash.stderr ||
              `git config exited with status ${removeHash.status}`,
          );
        }
      }
    } catch (error) {
      const pattern = registrationPath.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      failures.push({
        record: `Git config record "${dispatcherConfigKey}" for "${registrationPath}"`,
        command: `git config --local --unset ${dispatcherConfigKey} '^${pattern}$'`,
        error,
      });
    }
  } else {
    // The dispatcher record is multi-valued; the hash record is single-valued.
    for (const [key, flag] of [
      [dispatcherConfigKey, "--unset-all"],
      [dispatcherHashConfigKey, "--unset"],
    ]) {
      const remove = runGit(["config", "--local", flag, key]);
      if (remove.status !== 0 && remove.status !== 5) {
        failures.push({
          record: `Git config record "${key}"`,
          command: `git config --local ${flag} ${key}`,
          error: new Error(
            remove.stderr || `git config exited with status ${remove.status}`,
          ),
        });
      }
    }
  }

  if (removeDirectory) {
    try {
      rmSync(registrationsDirectory, { recursive: true, force: true });
    } catch (error) {
      failures.push({
        record: `registration directory "${registrationsDirectory}"`,
        command: `rm -rf ${shellQuote(registrationsDirectory)}`,
        error,
      });
    }
  }

  if (failures.length === 0) {
    return;
  }

  process.stderr.write(
    [
      removeDirectory
        ? "The original pre-commit hook is already restored, but dispatcher record cleanup did not finish."
        : "The repository was unregistered from the shared dispatcher, but record cleanup did not finish.",
      "The following records may remain:",
      ...failures.flatMap(({ record, command, error }) => [
        `- ${record}: ${error instanceof Error ? error.message : String(error)}`,
        `  Remove it manually with: ${command}`,
      ]),
      'After resolving the filesystem or Git config error, safely retry with "pnpm run hooks:dispatcher:uninstall".',
      removeDirectory
        ? "The retry only removes the remaining dispatcher records; it does not replace the restored developer hook."
        : "The retry only removes the remaining dispatcher records; the shared dispatcher and other registrations stay in place.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function reportDispatcherStatus(configuredPath) {
  const repositoryRoot = resolve(workspace);
  const directory =
    configuredPath === null
      ? resolveDefaultHooksDirectory()
      : hooksDirectory(configuredPath);
  const hookPath = join(directory, "pre-commit");
  const preservedPath = join(directory, preservedHookName);
  const registrationsDirectory = join(directory, registrationsDirectoryName);
  const registrationPath = join(registrationsDirectory, registrationName());
  const activeHook = !existsSync(hookPath)
    ? "absent"
    : isManagedDispatcher(hookPath)
      ? "dispatcher"
      : "developer hook";
  const registrationPresent = existsSync(registrationPath);
  const dispatcherRecord = readGitConfig(dispatcherConfigKey);
  const dispatcherHashRecord = readGitConfig(dispatcherHashConfigKey);

  process.stdout.write(
    [
      `Repository: "${repositoryRoot}"`,
      `Active pre-commit hook: ${activeHook} ("${hookPath}")`,
      `Preserved developer hook: ${existsSync(preservedPath) ? `present ("${preservedPath}")` : "absent"}`,
      `Repository registration file: ${
        registrationPresent
          ? `present ("${registrationPath}")`
          : `absent ("${registrationPath}")`
      }`,
      `Git config ${dispatcherConfigKey}: ${dispatcherRecord === null ? "absent" : JSON.stringify(dispatcherRecord)}`,
      `Git config ${dispatcherHashConfigKey}: ${dispatcherHashRecord === null ? "absent" : JSON.stringify(dispatcherHashRecord)}`,
      "",
    ].join("\n"),
  );
}

function resolveDefaultHooksDirectory() {
  const result = runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr || "Unable to identify the default Git hooks directory.",
    );
  }
  return resolve(workspace, result.stdout.trim());
}

function uninstallDispatcher(configuredPath) {
  const directory = hooksDirectory(configuredPath);
  const hookPath = join(directory, "pre-commit");
  const preservedPath = join(directory, preservedHookName);
  const registrationsDirectory = join(directory, registrationsDirectoryName);
  const registrationPath = join(registrationsDirectory, registrationName());
  const repositoryRoot = resolve(workspace);
  migrateLegacyRegistration(registrationsDirectory);
  const managedDispatcher = isManagedDispatcher(hookPath);
  const recordedDispatcherValues = readGitConfigValues(dispatcherConfigKey);
  const recordedHash = runGit([
    "config",
    "--local",
    "--get",
    dispatcherHashConfigKey,
  ]);
  const emptyRegistrationsDirectory =
    existsSync(registrationsDirectory) &&
    readdirSync(registrationsDirectory).length === 0;
  const cleanupRetry =
    !managedDispatcher &&
    !existsSync(preservedPath) &&
    (emptyRegistrationsDirectory ||
      existsSync(registrationPath) ||
      recordedDispatcherValues.includes(registrationPath) ||
      recordedHash.status === 0);

  if (cleanupRetry) {
    cleanupDispatcherRecords(registrationPath, registrationsDirectory);
    process.stdout.write(
      `Finished removing the remaining dispatcher records. The hook at "${hookPath}" was left unchanged.\n`,
    );
    return;
  }

  if (!managedDispatcher) {
    process.stderr.write(
      `Refusing to uninstall: "${hookPath}" is not a repository-managed dispatcher.\n`,
    );
    process.exit(1);
  }

  // A registration file only counts when its recorded target is this
  // worktree; a legacy file may carry this worktree's name while serving a
  // sibling. A missing file falls back to the recorded values.
  const registrationFileExists = existsSync(registrationPath);
  const targetsHere =
    registrationFileExists &&
    registrationTarget(registrationPath) === repositoryRoot;
  const recordedHere =
    !registrationFileExists &&
    recordedDispatcherValues.includes(registrationPath);
  if (!targetsHere && !recordedHere) {
    process.stderr.write(
      `Refusing to uninstall: this repository is not registered with "${hookPath}".\n`,
    );
    process.exit(1);
  }

  const currentHash = dispatcherHash(readFileSync(hookPath, "utf8"));
  if (
    recordedHash.status !== 0 ||
    recordedHash.stdout.trim() !== currentHash
  ) {
    process.stderr.write(
      [
        `Refusing to uninstall: "${hookPath}" changed after the dispatcher was installed or its installation record is missing.`,
        `Preserve your edits by copying or moving "${hookPath}" before making any changes.`,
        existsSync(preservedPath)
          ? `To restore the original hook manually, move "${preservedPath}" to "${hookPath}" after preserving the edited dispatcher.`
          : `No preserved original hook exists; remove or replace "${hookPath}" manually after preserving any edits you need.`,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const remainingRegistrations = existsSync(registrationsDirectory)
    ? readdirSync(registrationsDirectory).filter(
        (name) => name.endsWith(".sh") && name !== registrationName(),
      )
    : [];
  if (remainingRegistrations.length > 0) {
    cleanupDispatcherRecords(registrationPath, registrationsDirectory, {
      removeDirectory: false,
      keepSurvivingRecords: true,
    });
    process.stdout.write(
      `Unregistered this repository from the shared pre-commit dispatcher at "${hookPath}".\n`,
    );
    return;
  }

  if (existsSync(preservedPath)) {
    try {
      // Replacing the dispatcher directly keeps an active hook at hookPath for
      // the entire operation. A failed rename leaves both files untouched.
      renameSync(preservedPath, hookPath);
    } catch (error) {
      process.stderr.write(
        [
          `Unable to restore the original pre-commit hook: ${error instanceof Error ? error.message : String(error)}`,
          `The active dispatcher remains at "${hookPath}".`,
          `The original hook remains recoverable at "${preservedPath}".`,
          `After resolving the filesystem or permission error, restore it manually by moving "${preservedPath}" to "${hookPath}", replacing the dispatcher.`,
          "No dispatcher registration or installation records were removed.",
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
  } else {
    rmSync(hookPath);
  }

  cleanupDispatcherRecords(registrationPath, registrationsDirectory);
  if (existsSync(hookPath)) {
    process.stdout.write(
      `Restored the original pre-commit hook at "${hookPath}".\n`,
    );
  } else {
    process.stdout.write(
      `Removed the pre-commit dispatcher at "${hookPath}".\n`,
    );
  }
}

const repository = runGit(["rev-parse", "--git-dir"]);
if (repository.status !== 0) {
  process.exit(0);
}

const configured = runGit(["config", "--get", "core.hooksPath"]);
if (mode === "--dispatcher-status" && configured.status === 1) {
  reportDispatcherStatus(null);
  process.exit(0);
}
if (configured.status === 1) {
  const install = runGit([
    "config",
    "--local",
    "core.hooksPath",
    repositoryHooksPath,
  ]);
  if (install.status !== 0) {
    process.stderr.write(
      install.stderr || "Unable to configure the repository Git hooks.\n",
    );
    process.exit(install.status ?? 1);
  }
  process.exit(0);
}

if (configured.status !== 0) {
  process.stderr.write(
    configured.stderr || "Unable to read the configured Git hooks path.\n",
  );
  process.exit(configured.status ?? 1);
}

const existingHooksPath = configured.stdout.trim();
if (existingHooksPath === repositoryHooksPath) {
  if (
    mode === "--install-dispatcher" ||
    mode === "--uninstall-dispatcher" ||
    mode === "--dispatcher-status"
  ) {
    process.stderr.write(
      `No dispatcher is needed because core.hooksPath already points to "${repositoryHooksPath}".\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (
  mode === "--install-dispatcher" ||
  mode === "--uninstall-dispatcher" ||
  mode === "--dispatcher-status"
) {
  const localHooksPath = runGit([
    "config",
    "--local",
    "--get",
    "core.hooksPath",
  ]);
  if (localHooksPath.status !== 0 && localHooksPath.status !== 1) {
    process.stderr.write(
      localHooksPath.stderr ||
        "Unable to verify that the custom hooks path is repository-local.\n",
    );
    process.exit(localHooksPath.status ?? 1);
  }
}

if (mode === "--install-dispatcher") {
  withDispatcherLock(existingHooksPath, () =>
    installDispatcher(existingHooksPath),
  );
  process.exit(0);
}
if (mode === "--uninstall-dispatcher") {
  withDispatcherLock(existingHooksPath, () =>
    uninstallDispatcher(existingHooksPath),
  );
  process.exit(0);
}
if (mode === "--dispatcher-status") {
  reportDispatcherStatus(existingHooksPath);
  process.exit(0);
}

const chained = runGit(["config", "--local", "--get", chainedConfigKey]);
if (chained.status === 0 && chained.stdout.trim() === "true") {
  process.exit(0);
}
if (chained.status !== 0 && chained.status !== 1) {
  process.stderr.write(
    chained.stderr ||
      "Unable to read the repository Git hook chaining acknowledgement.\n",
  );
  process.exit(chained.status ?? 1);
}

// Only this worktree's own registration file proves registration: the
// dispatcher record is shared by every worktree of the repository, so values
// read from the shared config must not mark this worktree as protected. A
// legacy registration file may carry this worktree's name while targeting a
// sibling, so its recorded target must match this worktree as well.
const ownRegistration = join(
  hooksDirectory(existingHooksPath),
  registrationsDirectoryName,
  registrationName(),
);
if (
  existsSync(ownRegistration) &&
  registrationTarget(ownRegistration) === resolve(workspace)
) {
  process.exit(0);
}

process.stderr.write(
  [
    `Git hooks are already configured at "${existingHooksPath}".`,
    `Setup left that configuration unchanged instead of replacing it with "${repositoryHooksPath}".`,
    `Chain "${repositoryHooksPath}/pre-commit" from your existing pre-commit hook,`,
    `or update your hooks setup so both paths run.`,
    `The repository hook runs "pnpm run validate:staged-codegen-backups".`,
    `To install an opt-in dispatcher that preserves and runs your existing hook:`,
    `  pnpm run hooks:dispatcher:install`,
    `Rollback is available with:`,
    `  pnpm run hooks:dispatcher:uninstall`,
    `Alternatively, chain it manually and acknowledge that setup as follows.`,
    `After both hooks run, acknowledge the chaining with:`,
    `  git config --local ${chainedConfigKey} true`,
    `Then run "pnpm install" again.`,
    "",
  ].join("\n"),
);
process.exit(1);
