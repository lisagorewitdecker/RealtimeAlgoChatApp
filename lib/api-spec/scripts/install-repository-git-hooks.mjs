import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
const dispatcherMarker = "# replit-repository-hook-dispatcher";
const preservedHookName = "pre-commit.replit-preserved";
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

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isManagedDispatcher(path) {
  return (
    existsSync(path) &&
    readFileSync(path, "utf8").startsWith(`#!/bin/sh\n${dispatcherMarker}\n`)
  );
}

function installDispatcher(configuredPath) {
  const directory = hooksDirectory(configuredPath);
  const hookPath = join(directory, "pre-commit");
  const preservedPath = join(directory, preservedHookName);

  mkdirSync(directory, { recursive: true });
  if (isManagedDispatcher(hookPath)) {
    const record = runGit([
      "config",
      "--local",
      dispatcherConfigKey,
      "true",
    ]);
    if (record.status !== 0) {
      process.stderr.write(
        record.stderr || "Unable to record the installed hook dispatcher.\n",
      );
      process.exit(record.status ?? 1);
    }
    process.exit(0);
  }
  if (existsSync(preservedPath)) {
    process.stderr.write(
      `Refusing to install: "${preservedPath}" already exists. Move or remove it, then retry.\n`,
    );
    process.exit(1);
  }

  const hadDeveloperHook = existsSync(hookPath);
  if (hadDeveloperHook) {
    renameSync(hookPath, preservedPath);
  }

  const repositoryHook = repositoryHookPath();
  const dispatcher = [
    "#!/bin/sh",
    dispatcherMarker,
    "set -u",
    "",
    `repository_hook=${shellQuote(repositoryHook)}`,
    `developer_hook=${shellQuote(preservedPath)}`,
    "",
    'sh "$repository_hook" "$@"',
    "repository_status=$?",
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

  try {
    writeFileSync(hookPath, dispatcher, { mode: 0o755, flag: "wx" });
    chmodSync(hookPath, 0o755);
    const record = runGit([
      "config",
      "--local",
      dispatcherConfigKey,
      "true",
    ]);
    if (record.status !== 0) {
      throw new Error(
        record.stderr || "Unable to record the installed hook dispatcher.",
      );
    }
  } catch (error) {
    rmSync(hookPath, { force: true });
    if (hadDeveloperHook) {
      renameSync(preservedPath, hookPath);
    }
    runGit(["config", "--local", "--unset", dispatcherConfigKey]);
    throw error;
  }

  process.stdout.write(
    [
      `Installed an opt-in pre-commit dispatcher at "${hookPath}".`,
      hadDeveloperHook
        ? `The existing hook was preserved unchanged at "${preservedPath}".`
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

  if (!isManagedDispatcher(hookPath)) {
    process.stderr.write(
      `Refusing to uninstall: "${hookPath}" is not a repository-managed dispatcher.\n`,
    );
    process.exit(1);
  }

  rmSync(hookPath);
  if (existsSync(preservedPath)) {
    renameSync(preservedPath, hookPath);
    process.stdout.write(`Restored the original pre-commit hook at "${hookPath}".\n`);
  } else {
    process.stdout.write(`Removed the pre-commit dispatcher at "${hookPath}".\n`);
  }
  runGit(["config", "--local", "--unset", dispatcherConfigKey]);
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
  if (localHooksPath.status === 1) {
    process.stderr.write(
      [
        `Refusing to modify the globally configured hooks directory at "${existingHooksPath}".`,
        "A shared dispatcher would affect other repositories.",
        "Configure a repository-local hooks path or use the manual chaining instructions instead.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (localHooksPath.status !== 0) {
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
  dispatcherInstalled.stdout.trim() === "true"
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