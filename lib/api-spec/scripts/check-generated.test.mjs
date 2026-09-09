import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkerPath = fileURLToPath(
  new URL("./check-generated.mjs", import.meta.url),
);
const generatedFiles = {
  "lib/api-client-react/src/generated/client.ts":
    "export const localReactClientEdit = true;\n",
  "lib/api-zod/src/generated/types.ts":
    "export const localZodTypesEdit = true;\n",
  "lib/api-zod/src/index.ts":
    'export { localZodTypesEdit } from "./generated/types";\n',
};
const changedGeneratedFile = "lib/api-client-react/src/generated/client.ts";
const newGeneratedFile = "lib/api-zod/src/generated/regenerated.ts";

function createFixture(behavior) {
  const root = mkdtempSync(join(tmpdir(), "api-codegen-check-fixture-"));
  for (const [path, contents] of Object.entries(generatedFiles)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }

  const pnpmPath = join(root, "bin", "pnpm");
  mkdirSync(dirname(pnpmPath), { recursive: true });
  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const changedFile = join(root, ${JSON.stringify(changedGeneratedFile)});
const newFile = join(root, ${JSON.stringify(newGeneratedFile)});

if (${JSON.stringify(behavior)} !== "no-drift") {
  mkdirSync(dirname(changedFile), { recursive: true });
  writeFileSync(changedFile, "codegen output\\n");
  mkdirSync(dirname(newFile), { recursive: true });
  writeFileSync(newFile, "new generated output\\n");
}

if (${JSON.stringify(behavior)} === "failure") {
  console.error("fixture codegen failure");
  process.exit(23);
}
`,
  );
  chmodSync(pnpmPath, 0o755);

  return { root, pnpmPath };
}

function runChecker(root, pnpmPath) {
  try {
    const output = execFileSync(process.execPath, [checkerPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        API_CODEGEN_CHECK_WORKSPACE: root,
        PATH: `${dirname(pnpmPath)}:${process.env.PATH}`,
      },
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function assertGeneratedFilesRestored(root) {
  for (const [path, expected] of Object.entries(generatedFiles)) {
    assert.deepEqual(
      readFileSync(join(root, path)),
      Buffer.from(expected),
      `${path} was not restored byte-for-byte`,
    );
  }
  assert.equal(
    existsSync(join(root, newGeneratedFile)),
    false,
    "new generated files must be removed during restoration",
  );
}

function withFixture(behavior, callback) {
  const fixture = createFixture(behavior);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("succeeds and preserves generated files when codegen has no drift", () => {
  withFixture("no-drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.equal(result.status, 0);
    assert.match(result.output, /Generated API clients match/);
    assertGeneratedFilesRestored(root);
  });
});

test("fails on generated drift and restores every generated file", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Generated API drift detected/);
    assertGeneratedFilesRestored(root);
  });
});

test("fails on codegen errors and restores every generated file", () => {
  withFixture("failure", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /API client regeneration failed/);
    assertGeneratedFilesRestored(root);
  });
});
