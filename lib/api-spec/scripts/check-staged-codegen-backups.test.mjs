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
const backupDirectoryPrefix = ".api-codegen-check-";

function withGitFixture(action) {
  const root = mkdtempSync(join(tmpdir(), "staged-codegen-backups-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stage(root, path, contents = "fixture\n") {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  execFileSync("git", ["add", path], { cwd: root });
}

function runChecker(root) {
  const result = spawnSync(process.execPath, [checkerPath], {
    env: { ...process.env, API_CODEGEN_CHECK_WORKSPACE: root },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("rejects a staged root-level recovery directory with recovery-first guidance", () => {
  withGitFixture((root) => {
    stage(root, `${backupDirectoryPrefix}recovery/generated.ts`);

    const result = runChecker(root);

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
  withGitFixture((root) => {
    stage(root, "ordinary-file.txt");
    assert.equal(runChecker(root).status, 0);
  });
});

test("allows the backup prefix below a normal root directory", () => {
  withGitFixture((root) => {
    stage(root, `fixtures/${backupDirectoryPrefix}example/file.txt`);
    assert.equal(runChecker(root).status, 0);
  });
});

test("keeps recovery backup directories visible to git status", () => {
  const gitignore = readFileSync(
    new URL("../../../.gitignore", import.meta.url),
    "utf8",
  );
  assert.equal(gitignore.includes(backupDirectoryPrefix), false);
});

test("installs and runs the staged-backup check as the repository pre-commit hook", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const hook = readFileSync(
    new URL("../../../.githooks/pre-commit", import.meta.url),
    "utf8",
  );

  assert.match(packageJson.scripts.prepare, /core\.hooksPath \.githooks/);
  assert.equal(
    packageJson.scripts["validate:staged-codegen-backups"],
    "node lib/api-spec/scripts/check-staged-codegen-backups.mjs",
  );
  assert.match(hook, /pnpm run validate:staged-codegen-backups/);
});