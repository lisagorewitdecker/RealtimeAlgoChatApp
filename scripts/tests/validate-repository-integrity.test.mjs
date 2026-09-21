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

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const checkerPath = join(workspaceRoot, "scripts/validate-repository-integrity.mjs");

function withGitFixture(action) {
  const root = mkdtempSync(join(tmpdir(), "repository-integrity-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  execFileSync("git", ["init", "--quiet"], { cwd: root, env });
  try {
    return action(root, env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixture(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function trackAll(root, env) {
  execFileSync("git", ["add", "--all"], { cwd: root, env });
}

function runChecker(root, env) {
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("passes a clean tracked tree and ignores integer ratios without repetition", () => {
  withGitFixture((root, env) => {
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    writeFixture(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFixture(root, "scripts/check.sh", "#!/bin/sh\nprintf clean\\n\n");
    writeFixture(root, "scripts/check.mjs", "console.log('clean');\n");
    writeFixture(root, "ratio.txt", "abcdef");
    trackAll(root, env);

    const result = runChecker(root, env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Repository integrity validated/);
  });
});

test("flags verbatim whole-file copies", () => {
  withGitFixture((root, env) => {
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    writeFixture(root, "duplicate.txt", "first line\nsecond line\n".repeat(3));
    trackAll(root, env);

    const result = runChecker(root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /duplicate\.txt: whole-file self-repetition: 3 verbatim copies/);
  });
});

test("flags copies joined after stripping the first trailing newline", () => {
  withGitFixture((root, env) => {
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    const original = Buffer.from("first line\nsecond line\n");
    writeFixture(
      root,
      "joined.txt",
      Buffer.concat([original.subarray(0, -1), original, original]),
    );
    trackAll(root, env);

    const result = runChecker(root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /joined\.txt: whole-file self-repetition: 3 mid-line copies/);
  });
});

test("reports malformed tracked manifests and source syntax", () => {
  withGitFixture((root, env) => {
    writeFixture(root, "bad.json", '{"name":}\n');
    writeFixture(root, "pnpm-lock.yaml", "key: [unterminated\n");
    writeFixture(root, "bad.sh", "#!/bin/sh\nif true; then\n");
    writeFixture(root, "bad.mjs", "const broken = ;\n");
    trackAll(root, env);

    const result = runChecker(root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /bad\.json: JSON parse error/);
    assert.match(result.output, /pnpm-lock\.yaml: YAML parse error/);
    assert.match(result.output, /bad\.sh: shell syntax error/);
    assert.match(result.output, /bad\.mjs: JavaScript syntax error/);
  });
});

test("the repository hook runs integrity validation before staged backup validation", () => {
  const hook = readFileSync(join(workspaceRoot, ".githooks/pre-commit"), "utf8");
  assert.match(hook, /pnpm run validate:repository-integrity/);
  assert.match(
    hook,
    /pnpm run validate:repository-integrity[\s\S]*pnpm run validate:staged-codegen-backups/,
  );
});