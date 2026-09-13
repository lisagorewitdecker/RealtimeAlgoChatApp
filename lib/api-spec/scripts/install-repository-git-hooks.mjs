import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
  const commonDirectory = runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDirectory.status !== 0) {
    process.stderr.write(
      commonDirectory.stderr || "Unable to identify the Git repository.\n",
    );
    process.exit(commonDirectory.status ?? 1);
  }
  return resolve(workspace, commonDirectory.stdout.trim());
}

function registrationName() {
  return `${createHash("sha256").update(repositoryIdentity()).digest("hex")}.sh`;
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

function recordDispatcher(registrationPath, hash) {
  const record = runGit([
    "config",
    "--local",
    dispatcherConfigKey,
    registrationPath,
  ]);
  if (record.status !== 0) {
    throw new Error(
      record.stderr || "Unable to record the installed hook dispatcher.",
    );
  }
  const recordHash = runGit([
    "config",
    "--local",
    dispatcherHashConfigKey,
    hash,
  ]);
  if (recordHash.status !== 0) {
    runGit(["config", "--local", "--unset", dispatcherConfigKey]);
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
  if (!alreadyManaged && existsSync(preservedPath)) {
    process.stderr.write(
      `Refusing to install: "${preservedPath}" already exists. Move or remove it, then retry.\n`,
    );
    process.exit(1);
  }

  const hadDeveloperHook = !alreadyManaged && existsSync(hookPath);
  if (hadDeveloperHook) {
    renameSync(hookPath, preservedPath);
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

  try {
    mkdirSync(registrationsDirectory, { recursive: true });
    writeFileSync(registrationPath, registration, { mode: 0o755 });
    chmodSync(registrationPath, 0o755);
    if (!alreadyManaged) {
      writeFileSync(hookPath, dispatcher, { mode: 0o755, flag: "wx" });
    } else {
      writeFileSync(hookPath, dispatcher, { mode: 0o755 });
    }
    chmodSync(hookPath, 0o755);
    recordDispatcher(registrationPath, hash);
  } catch (error) {
    rmSync(registrationPath, { force: true });
    if (!alreadyManaged) {
      if (hadDeveloperHook) {
        try {
          // Replacing the dispatcher directly keeps an active hook at hookPath
          // for the entire rollback. A failed rename leaves both copies intact.
          renameSync(preservedPath, hookPath);
        } catch (restoreError) {
          runGit(["config", "--local", "--unset", dispatcherConfigKey]);
          runGit(["config", "--local", "--unset", dispatcherHashConfigKey]);
          process.stderr.write(
            [
              `Dispatcher installation failed: ${error instanceof Error ? error.message : String(error)}`,
              `Unable to restore the original pre-commit hook: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
              `The active dispatcher remains at "${hookPath}".`,
              `The original hook remains recoverable at "${preservedPath}".`,
              `After resolving the filesystem or permission error, restore it manually by moving "${preservedPath}" to "${hookPath}", replacing the dispatcher.`,
              "",
            ].join("\n"),
          );
          process.exit(1);
        }
      } else {
        rmSync(hookPath, { force: true });
      }
    }
    runGit(["config", "--local", "--unset", dispatcherConfigKey]);
    runGit(["config", "--local", "--unset", dispatcherHashConfigKey]);
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

function uninstallDispatcher(configuredPath) {
  const directory = hooksDirectory(configuredPath);
  const hookPath = join(directory, "pre-commit");
  const preservedPath = join(directory, preservedHookName);
  const registrationsDirectory = join(directory, registrationsDirectoryName);
  const registrationPath = join(registrationsDirectory, registrationName());

  if (!isManagedDispatcher(hookPath)) {
    process.stderr.write(
      `Refusing to uninstall: "${hookPath}" is not a repository-managed dispatcher.\n`,
    );
    process.exit(1);
  }

  if (!existsSync(registrationPath)) {
    process.stderr.write(
      `Refusing to uninstall: this repository is not registered with "${hookPath}".\n`,
    );
    process.exit(1);
  }

  const recordedHash = runGit([
    "config",
    "--local",
    "--get",
    dispatcherHashConfigKey,
  ]);
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
    rmSync(registrationPath);
    runGit(["config", "--local", "--unset", dispatcherConfigKey]);
    runGit(["config", "--local", "--unset", dispatcherHashConfigKey]);
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

  rmSync(registrationPath);
  runGit(["config", "--local", "--unset", dispatcherConfigKey]);
  runGit(["config", "--local", "--unset", dispatcherHashConfigKey]);
  rmSync(registrationsDirectory, { recursive: true, force: true });
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
  if (mode === "--install-dispatcher" || mode === "--uninstall-dispatcher") {
    process.stderr.write(
      `No dispatcher is needed because core.hooksPath already points to "${repositoryHooksPath}".\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "--install-dispatcher" || mode === "--uninstall-dispatcher") {
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
  installDispatcher(existingHooksPath);
  process.exit(0);
}
if (mode === "--uninstall-dispatcher") {
  uninstallDispatcher(existingHooksPath);
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

const dispatcherInstalled = runGit([
  "config",
  "--local",
  "--get",
  dispatcherConfigKey,
]);
if (
  dispatcherInstalled.status === 0 &&
  (dispatcherInstalled.stdout.trim() === "true" ||
    existsSync(dispatcherInstalled.stdout.trim()))
) {
  process.exit(0);
}
if (dispatcherInstalled.status !== 0 && dispatcherInstalled.status !== 1) {
  process.stderr.write(
    dispatcherInstalled.stderr ||
      "Unable to read the repository Git hook dispatcher state.\n",
  );
  process.exit(dispatcherInstalled.status ?? 1);
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
