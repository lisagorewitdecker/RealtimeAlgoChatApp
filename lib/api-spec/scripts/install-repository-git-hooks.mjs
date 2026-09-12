import { spawnSync } from "node:child_process";

const workspace = process.env.REPOSITORY_HOOKS_WORKSPACE ?? process.cwd();
const repositoryHooksPath = ".githooks";
const chainedConfigKey = "replit.repositoryHooksChained";

function runGit(args) {
  return spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
  });
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

process.stderr.write(
  [
    `Git hooks are already configured at "${existingHooksPath}".`,
    `Setup left that configuration unchanged instead of replacing it with "${repositoryHooksPath}".`,
    `Chain "${repositoryHooksPath}/pre-commit" from your existing pre-commit hook,`,
    `or update your hooks setup so both paths run.`,
    `The repository hook runs "pnpm run validate:staged-codegen-backups".`,
    `After both hooks run, acknowledge the chaining with:`,
    `  git config --local ${chainedConfigKey} true`,
    `Then run "pnpm install" again.`,
    "",
  ].join("\n"),
);
process.exit(1);