import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
const codegenMarkerFile = "codegen-ran";
const backupDirectoryPrefix = ".api-codegen-check-";
// Permission failures cannot be simulated when running as root because root
// bypasses file mode checks.
const permissionTestOptions = {
  skip:
    process.getuid?.() === 0 &&
    "permission failures cannot be simulated as root",
};

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
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const behavior = ${JSON.stringify(behavior)};
const root = process.cwd();
const changedFile = join(root, ${JSON.stringify(changedGeneratedFile)});
const newFile = join(root, ${JSON.stringify(newGeneratedFile)});

writeFileSync(join(root, ${JSON.stringify(codegenMarkerFile)}), "");

if (behavior !== "no-drift") {
  mkdirSync(dirname(changedFile), { recursive: true });
  writeFileSync(changedFile, "codegen output\\n");
  mkdirSync(dirname(newFile), { recursive: true });
  writeFileSync(newFile, "new generated output\\n");
}

if (behavior === "failure") {
  console.error("fixture codegen failure");
  process.exit(23);
}

if (behavior === "restore-failure") {
  // A read-only file inside a read-only directory can be neither removed nor
  // overwritten, so restoring this path fails at both steps.
  chmodSync(changedFile, 0o444);
  chmodSync(dirname(changedFile), 0o555);
}

if (behavior === "cleanup-failure") {
  const backupDirectory = readdirSync(root).find((entry) =>
    entry.startsWith(${JSON.stringify(backupDirectoryPrefix)}),
  );
  chmodSync(join(root, backupDirectory), 0o555);
}

if (behavior === "unreadable-output") {
  chmodSync(newFile, 0o000);
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

function findBackupDirectories(root) {
  return readdirSync(root).filter((entry) =>
    entry.startsWith(backupDirectoryPrefix),
  );
}

function assertBackupDirectoryRemoved(root) {
  assert.deepEqual(
    findBackupDirectories(root),
    [],
    "the temporary backup directory must be removed",
  );
}

// Fixtures deliberately lock files and directories; reopen them so the
// fixture can be deleted no matter where a run stopped.
function unlockTree(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry || entry.isSymbolicLink()) {
    return;
  }
  if (entry.isDirectory()) {
    chmodSync(path, 0o755);
    for (const child of readdirSync(path)) {
      unlockTree(join(path, child));
    }
  } else {
    chmodSync(path, 0o644);
  }
}

function withFixture(behavior, callback) {
  const fixture = createFixture(behavior);
  try {
    callback(fixture);
  } finally {
    unlockTree(fixture.root);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("succeeds and preserves generated files when codegen has no drift", () => {
  withFixture("no-drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.equal(result.status, 0);
    assert.match(result.output, /Generated API clients match/);
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("fails on generated drift and restores every generated file", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Generated API drift detected/);
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("fails on codegen errors and restores every generated file", () => {
  withFixture("failure", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /API client regeneration failed/);
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test(
  "reports each failed restoration step and keeps the backup when generated files cannot be restored",
  permissionTestOptions,
  () => {
    withFixture("restore-failure", ({ root, pnpmPath }) => {
      const result = runChecker(root, pnpmPath);

      assert.notEqual(result.status, 0);
      assert.match(
        result.output,
        /Could not restore the generated API clients after regeneration:/,
      );
      assert.match(
        result.output,
        /- Removing regenerated output at lib\/api-client-react\/src\/generated failed: /,
      );
      assert.match(
        result.output,
        /- Restoring lib\/api-client-react\/src\/generated from its backup failed: /,
      );
      assert.doesNotMatch(
        result.output,
        /restored to their original state|Generated API clients match/,
      );

      const backupDirectories = findBackupDirectories(root);
      assert.equal(
        backupDirectories.length,
        1,
        "the backup must be kept when restoration fails",
      );
      const backupDirectory = join(root, backupDirectories[0]);
      assert.ok(
        result.output.includes(
          `Your original generated files are preserved in ${backupDirectory}.`,
        ),
        `output must name the preserved backup directory:\n${result.output}`,
      );
      for (const [path, expected] of Object.entries(generatedFiles)) {
        assert.deepEqual(
          readFileSync(join(backupDirectory, path)),
          Buffer.from(expected),
          `${path} is missing from the preserved backup`,
        );
      }

      // The locked path still holds the regenerated output, while every other
      // path was restored despite the earlier failure.
      assert.equal(
        readFileSync(join(root, changedGeneratedFile), "utf8"),
        "codegen output\n",
      );
      assert.deepEqual(
        readFileSync(join(root, "lib/api-zod/src/generated/types.ts")),
        Buffer.from(generatedFiles["lib/api-zod/src/generated/types.ts"]),
      );
      assert.deepEqual(
        readFileSync(join(root, "lib/api-zod/src/index.ts")),
        Buffer.from(generatedFiles["lib/api-zod/src/index.ts"]),
      );
      assert.equal(existsSync(join(root, newGeneratedFile)), false);
    });
  },
);

test(
  "reports a failed backup cleanup after a successful restoration",
  permissionTestOptions,
  () => {
    withFixture("cleanup-failure", ({ root, pnpmPath }) => {
      const result = runChecker(root, pnpmPath);

      assert.notEqual(result.status, 0);
      assert.match(
        result.output,
        /Cleanup after checking the generated API clients did not finish:/,
      );
      assert.match(
        result.output,
        /- Removing the temporary backup directory .*\.api-codegen-check-\S+ failed: /,
      );
      assert.match(
        result.output,
        /Delete .*\.api-codegen-check-\S+ manually\./,
      );
      assert.doesNotMatch(result.output, /Could not restore/);
      assertGeneratedFilesRestored(root);
    });
  },
);

test(
  "restores generated files when the regenerated output cannot be read",
  permissionTestOptions,
  () => {
    withFixture("unreadable-output", ({ root, pnpmPath }) => {
      const result = runChecker(root, pnpmPath);

      assert.notEqual(result.status, 0);
      assert.match(
        result.output,
        /Could not read the regenerated API clients to compare them: /,
      );
      assertGeneratedFilesRestored(root);
      assertBackupDirectoryRemoved(root);
    });
  },
);

test(
  "stops before codegen and removes the backup when generated files cannot be backed up",
  permissionTestOptions,
  () => {
    withFixture("drift", ({ root, pnpmPath }) => {
      chmodSync(join(root, "lib/api-zod/src/generated/types.ts"), 0o000);

      const result = runChecker(root, pnpmPath);

      assert.notEqual(result.status, 0);
      assert.match(
        result.output,
        /Could not back up the generated API clients before regeneration: /,
      );
      assert.match(result.output, /No generated files were changed\./);
      assert.equal(
        existsSync(join(root, codegenMarkerFile)),
        false,
        "codegen must not run without a complete backup",
      );
      assert.equal(
        readFileSync(join(root, changedGeneratedFile), "utf8"),
        generatedFiles[changedGeneratedFile],
      );
      assertBackupDirectoryRemoved(root);
    });
  },
);
