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
import { execFileSync, spawn } from "node:child_process";
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
const descendantMarkerFile = "codegen-descendant-ran";
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
import { spawn } from "node:child_process";
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

if (behavior === "large-drift") {
  writeFileSync(
    changedFile,
    Array.from({ length: 3000 }, (_, index) => "export const generated" + index + " = " + index + ";").join("\\n") + "\\n",
  );
}

if (behavior === "failure") {
  console.error("fixture codegen failure");
  process.exit(23);
}

if (
  behavior === "restore-failure" ||
  behavior === "interrupt-restore-failure"
) {
  // A read-only file inside a read-only directory can be neither removed nor
  // overwritten, so restoring this path fails at both steps.
  chmodSync(changedFile, 0o444);
  chmodSync(dirname(changedFile), 0o555);
}

if (
  behavior === "sleep-until-signalled" ||
  behavior === "interrupt-restore-failure"
) {
  setInterval(() => {}, 1000);
}

if (behavior === "ignore-interrupt") {
  spawn(
    process.execPath,
    [
      "-e",
      ${JSON.stringify(`
        const { writeFileSync } = require("node:fs");
        const { join } = require("node:path");
        writeFileSync(join(process.cwd(), "${descendantMarkerFile}"), String(process.pid));
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `)},
    ],
    { cwd: root, stdio: "inherit" },
  );
  setInterval(() => {}, 1000);
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

function runChecker(root, pnpmPath, { summaryPath, signalAt } = {}) {
  const env = {
    ...process.env,
    API_CODEGEN_CHECK_WORKSPACE: root,
    PATH: `${dirname(pnpmPath)}:${process.env.PATH}`,
  };
  if (summaryPath) {
    env.GITHUB_STEP_SUMMARY = summaryPath;
  } else {
    delete env.GITHUB_STEP_SUMMARY;
  }
  if (signalAt) {
    env.API_CODEGEN_CHECK_TEST_SIGNAL_AT = signalAt;
  } else {
    delete env.API_CODEGEN_CHECK_TEST_SIGNAL_AT;
  }
  try {
    const output = execFileSync(process.execPath, [checkerPath], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

for (const [signalAt, codegenExpected] of [
  ["backup", false],
  ["restore", true],
]) {
  test(`defers cancellation during ${signalAt} until originals are safe`, () => {
    withFixture("no-drift", ({ root, pnpmPath }) => {
      const result = runChecker(root, pnpmPath, { signalAt });

      assert.equal(result.status, 143, result.output);
      assert.match(result.output, /interrupted by SIGTERM/);
      assert.equal(
        existsSync(join(root, codegenMarkerFile)),
        codegenExpected,
        `codegen ${codegenExpected ? "must" : "must not"} run`,
      );
      assertGeneratedFilesRestored(root);
      assertBackupDirectoryRemoved(root);
    });
  });
}

function startChecker(root, pnpmPath, { terminationGraceMs } = {}) {
  return spawn(process.execPath, [checkerPath], {
    cwd: root,
    env: {
      ...process.env,
      API_CODEGEN_CHECK_WORKSPACE: root,
      ...(terminationGraceMs === undefined
        ? {}
        : {
            API_CODEGEN_CHECK_TERMINATION_GRACE_MS:
              String(terminationGraceMs),
          }),
      PATH: `${dirname(pnpmPath)}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
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

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initializeGitFixture(root) {
  runGit(root, ["init", "--quiet"]);
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

async function withAsyncFixture(behavior, callback) {
  const fixture = createFixture(behavior);
  try {
    await callback(fixture);
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

test("keeps recovery backup directories visible to git status", () => {
  const gitignore = readFileSync(
    new URL("../../../.gitignore", import.meta.url),
    "utf8",
  );

  assert.equal(gitignore.includes(backupDirectoryPrefix), false);
});

test("rejects staged generated-client recovery backups", () => {
  withFixture("no-drift", ({ root, pnpmPath }) => {
    initializeGitFixture(root);
    const recoveryFile = join(
      root,
      `${backupDirectoryPrefix}recovery`,
      "lib/api-zod/src/index.ts",
    );
    mkdirSync(dirname(recoveryFile), { recursive: true });
    writeFileSync(recoveryFile, "local recovery copy\n");
    runGit(root, ["add", "."]);

    const result = runChecker(root, pnpmPath);

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
    assert.equal(
      existsSync(join(root, codegenMarkerFile)),
      false,
      "codegen must not run while a recovery backup is staged",
    );
  });
});

test("allows ordinary staged files", () => {
  withFixture("no-drift", ({ root, pnpmPath }) => {
    initializeGitFixture(root);
    writeFileSync(join(root, "ordinary-file.txt"), "ordinary staged content\n");
    runGit(root, ["add", "ordinary-file.txt"]);

    const result = runChecker(root, pnpmPath);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Generated API clients match/);
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("allows the backup prefix below a normal root directory", () => {
  withFixture("no-drift", ({ root, pnpmPath }) => {
    initializeGitFixture(root);
    const nestedFile = join(
      root,
      "fixtures",
      `${backupDirectoryPrefix}example`,
      "file.txt",
    );
    mkdirSync(dirname(nestedFile), { recursive: true });
    writeFileSync(nestedFile, "nested fixture\n");
    runGit(root, ["add", "."]);

    const result = runChecker(root, pnpmPath);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Generated API clients match/);
  });
});

test("refuses to run codegen while leftover backup directories exist", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const firstBackup = join(root, `${backupDirectoryPrefix}alpha`);
    const secondBackup = join(root, `${backupDirectoryPrefix}zulu`);
    mkdirSync(firstBackup);
    mkdirSync(secondBackup);

    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /Refusing to check generated API clients because leftover backup directories exist:/,
    );
    assert.ok(
      result.output.includes(`- ${firstBackup}`),
      `output must list the absolute backup path:\n${result.output}`,
    );
    assert.ok(
      result.output.includes(`- ${secondBackup}`),
      `output must list the absolute backup path:\n${result.output}`,
    );
    assert.match(
      result.output,
      /Recover any needed files by copying them back into the workspace, then delete each backup directory and re-run this check\./,
    );
    assert.equal(
      existsSync(join(root, codegenMarkerFile)),
      false,
      "codegen must not run while a leftover backup exists",
    );
    assertGeneratedFilesRestored(root);
    assert.deepEqual(findBackupDirectories(root), [
      `${backupDirectoryPrefix}alpha`,
      `${backupDirectoryPrefix}zulu`,
    ]);
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

test("shows a unified diff of the regenerated content when drift is detected", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /^- lib\/api-client-react\/src\/generated\/client\.ts \(modified: \+1 -1\)$/m,
    );
    assert.match(
      result.output,
      /^- lib\/api-zod\/src\/generated\/regenerated\.ts \(added: \+1\)$/m,
    );
    assert.match(
      result.output,
      /^--- a\/lib\/api-client-react\/src\/generated\/client\.ts\n\+\+\+ b\/lib\/api-client-react\/src\/generated\/client\.ts\n@@ -1 \+1 @@\n-export const localReactClientEdit = true;\n\+codegen output$/m,
    );
    assert.match(
      result.output,
      /^--- \/dev\/null\n\+\+\+ b\/lib\/api-zod\/src\/generated\/regenerated\.ts\n@@ -0,0 \+1 @@\n\+new generated output$/m,
    );
    assert.match(
      result.output,
      /Run `pnpm --filter @workspace\/api-spec run codegen` and commit the generated output\./,
    );
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("writes the drift report to the GitHub step summary as a diff block", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const summaryPath = join(root, "step-summary.md");
    const result = runChecker(root, pnpmPath, { summaryPath });

    assert.notEqual(result.status, 0);
    const reportMatch = result.output.match(
      /Generated API drift detected after regeneration:\n([\s\S]+)\n\nRun `pnpm --filter @workspace\/api-spec run codegen`/,
    );
    assert.ok(reportMatch, "the job output must contain the drift report");
    const summary = readFileSync(summaryPath, "utf8");
    assert.equal(
      summary,
      `## Generated API drift detected\n\n\`\`\`diff\n${reportMatch[1]}\n\`\`\`\n`,
      "the step summary must contain the same drift report as the job output",
    );
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("does not create a step summary during local drift checks", () => {
  withFixture("drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, "step-summary.md")), false);
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test("bounds the drift diff for large generated files and still restores them", () => {
  withFixture("large-drift", ({ root, pnpmPath }) => {
    const result = runChecker(root, pnpmPath);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Generated API drift detected/);
    assert.match(
      result.output,
      /^- lib\/api-client-react\/src\/generated\/client\.ts \(modified: \+3000 -1\)$/m,
    );
    assert.match(
      result.output,
      /more diff line\(s\) omitted for lib\/api-client-react\/src\/generated\/client\.ts \(showing 200 of 3002; limit 200 per file\)/,
    );
    const outputLines = result.output.split("\n").length;
    assert.ok(
      outputLines < 300,
      `drift output must stay bounded (got ${outputLines} lines)`,
    );
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

for (const [signal, expectedStatus] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`forwards ${signal} to codegen, restores generated files, and removes the backup`, async () => {
    await withAsyncFixture(
      "sleep-until-signalled",
      async ({ root, pnpmPath }) => {
        const checker = startChecker(root, pnpmPath);
        let output = "";
        checker.stdout.on("data", (chunk) => {
          output += chunk;
        });
        checker.stderr.on("data", (chunk) => {
          output += chunk;
        });

        await waitForFile(join(root, codegenMarkerFile));
        checker.kill(signal);
        const result = await waitForExit(checker);

        assert.equal(
          result.code,
          expectedStatus,
          `checker exit was ${JSON.stringify(result)}:\n${output}`,
        );
        assert.equal(result.signal, null);
        assert.match(output, new RegExp(`interrupted by ${signal}`));
        assertGeneratedFilesRestored(root);
        assertBackupDirectoryRemoved(root);
      },
    );
  });
}

test("forces unresponsive codegen to stop after the interrupt grace period and restores files", async () => {
  await withAsyncFixture("ignore-interrupt", async ({ root, pnpmPath }) => {
    const checker = startChecker(root, pnpmPath, {
      terminationGraceMs: 100,
    });
    let output = "";
    checker.stdout.on("data", (chunk) => {
      output += chunk;
    });
    checker.stderr.on("data", (chunk) => {
      output += chunk;
    });

    await waitForFile(join(root, descendantMarkerFile));
    checker.kill("SIGTERM");
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(`checker hung after forced termination:\n${output}`),
          ),
        3000,
      );
    });
    let result;
    try {
      result = await Promise.race([waitForExit(checker), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }

    assert.equal(
      result.code,
      143,
      `checker exit was ${JSON.stringify(result)}:\n${output}`,
    );
    assert.equal(result.signal, null);
    assert.match(
      output,
      /Codegen did not exit within 100ms after SIGTERM; forcing termination with SIGKILL\./,
    );
    assert.match(output, /interrupted by SIGTERM/);
    const descendantPid = Number.parseInt(
      readFileSync(join(root, descendantMarkerFile), "utf8"),
      10,
    );
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === "ESRCH",
      "the signal-ignoring codegen descendant must be terminated",
    );
    assertGeneratedFilesRestored(root);
    assertBackupDirectoryRemoved(root);
  });
});

test(
  "reports failed restoration after an interrupt and preserves the backup",
  permissionTestOptions,
  async () => {
    await withAsyncFixture(
      "interrupt-restore-failure",
      async ({ root, pnpmPath }) => {
        const checker = startChecker(root, pnpmPath);
        let output = "";
        checker.stdout.on("data", (chunk) => {
          output += chunk;
        });
        checker.stderr.on("data", (chunk) => {
          output += chunk;
        });

        await waitForFile(join(root, codegenMarkerFile));
        checker.kill("SIGINT");
        const result = await waitForExit(checker);

        assert.equal(result.code, 130);
        assert.match(
          output,
          /Could not restore the generated API clients after regeneration:/,
        );
        assert.match(
          output,
          /- Removing regenerated output at lib\/api-client-react\/src\/generated failed: /,
        );
        assert.match(
          output,
          /- Restoring lib\/api-client-react\/src\/generated from its backup failed: /,
        );

        const backupDirectories = findBackupDirectories(root);
        assert.equal(backupDirectories.length, 1);
        const backupDirectory = join(root, backupDirectories[0]);
        assert.ok(
          output.includes(
            `Your original generated files are preserved in ${backupDirectory}.`,
          ),
          `output must name the preserved backup directory:\n${output}`,
        );
      },
    );
  },
);

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
