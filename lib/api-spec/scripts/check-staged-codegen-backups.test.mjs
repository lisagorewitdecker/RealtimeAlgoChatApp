import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkerPath = fileURLToPath(
  new URL("./check-staged-codegen-backups.mjs", import.meta.url),
);
const hookInstallerPath = fileURLToPath(
  new URL("./install-repository-git-hooks.mjs", import.meta.url),
);
const backupDirectoryPrefix = ".api-codegen-check-";

function withGitFixture(action) {
  const root = mkdtempSync(join(tmpdir(), "staged-codegen-backups-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, env: gitEnv });
    action(root, gitEnv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stage(root, gitEnv, path, contents = "fixture\n") {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  execFileSync("git", ["add", path], { cwd: root, env: gitEnv });
}

function runChecker(root, gitEnv) {
  const result = spawnSync(process.execPath, [checkerPath], {
    env: { ...gitEnv, API_CODEGEN_CHECK_WORKSPACE: root },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runHookInstaller(root, gitEnv) {
  const result = spawnSync(process.execPath, [hookInstallerPath], {
    env: { ...gitEnv, REPOSITORY_HOOKS_WORKSPACE: root },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("rejects a staged root-level recovery directory with recovery-first guidance", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `${backupDirectoryPrefix}recovery/generated.ts`);

    const result = runChecker(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /recovery backup directories are staged:/);
    assert.match(result.output, /\.api-codegen-check-recovery/);
    assert.match(
      result.output,
      /may contain the only recovery copy of local generated-client edits/,
    );
    assert.match(
      result.output,
      /Review and recover any needed files, then remove the backup folders from the workspace and Git staging/,
    );
  });
});

test("allows ordinary staged files", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, "ordinary-file.txt");
    assert.equal(runChecker(root, gitEnv).status, 0);
  });
});

test("allows the backup prefix below a normal root directory", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `fixtures/${backupDirectoryPrefix}example/file.txt`);
    assert.equal(runChecker(root, gitEnv).status, 0);
  });
});

test("keeps recovery backup directories visible to git status", () => {
  const gitignore = readFileSync(
    new URL("../../../.gitignore", import.meta.url),
    "utf8",
  );
  assert.equal(gitignore.includes(backupDirectoryPrefix), false);
});

test("fresh clones install and run the staged-backup repository pre-commit hook", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const hook = readFileSync(
    new URL("../../../.githooks/pre-commit", import.meta.url),
    "utf8",
  );

  withGitFixture((root, gitEnv) => {
    assert.equal(runHookInstaller(root, gitEnv).status, 0);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".githooks",
    );
  });

  assert.equal(
    packageJson.scripts.prepare,
    "node lib/api-spec/scripts/install-repository-git-hooks.mjs",
  );
  assert.equal(
    packageJson.scripts["validate:staged-codegen-backups"],
    "node lib/api-spec/scripts/check-staged-codegen-backups.mjs",
  );
  assert.match(hook, /pnpm run validate:staged-codegen-backups/);
});

test("preconfigured custom hooks are preserved and setup succeeds after chaining is acknowledged", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--local", "core.hooksPath", ".developer-hooks"],
      { cwd: root, env: gitEnv },
    );

    const result = runHookInstaller(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".developer-hooks",
    );
    assert.match(result.output, /left that configuration unchanged/);
    assert.match(result.output, /Chain "\.githooks\/pre-commit"/);
    assert.match(
      result.output,
      /pnpm run validate:staged-codegen-backups/,
    );
    assert.match(
      result.output,
      /git config --local replit\.repositoryHooksChained true/,
    );

    execFileSync(
      "git",
      [
        "config",
        "--local",
        "replit.repositoryHooksChained",
        "true",
      ],
      { cwd: root, env: gitEnv },
    );

    const subsequentResult = runHookInstaller(root, gitEnv);
    assert.equal(subsequentResult.status, 0);
    assert.equal(subsequentResult.output, "");
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".developer-hooks",
    );
  });
});

test("globally configured custom hooks are preserved without a local override", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--global", "core.hooksPath", ".developer-global-hooks"],
      { cwd: root, env: gitEnv },
    );

    const result = runHookInstaller(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /Git hooks are already configured at "\.developer-global-hooks"/,
    );
    assert.match(result.output, /left that configuration unchanged/);
    assert.match(result.output, /Chain "\.githooks\/pre-commit"/);

    const localConfig = spawnSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(localConfig.status, 1);
    assert.equal(localConfig.stdout, "");
  });
});
