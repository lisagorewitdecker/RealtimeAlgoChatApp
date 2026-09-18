import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatDriftReport } from "./generated-drift-report.mjs";
import {
  backupDirectoryPrefix,
  findStagedBackupDirectories,
  reportStagedBackupDirectories,
} from "./staged-codegen-backups.mjs";

const testWorkspaceEnabled = process.argv.includes(
  "--enable-test-workspace",
);
const testWorkspace = testWorkspaceEnabled
  ? process.env.API_CODEGEN_CHECK_WORKSPACE
  : undefined;
const workspaceRoot = resolve(
  testWorkspace ?? fileURLToPath(new URL("../../..", import.meta.url)),
);
const generatedPaths = [
  "lib/api-client-react/src/generated",
  "lib/api-zod/src/generated",
  "lib/api-zod/src/index.ts",
];
const regenerationCommand =
  "pnpm --filter @workspace/api-spec run codegen";
function getTestFaultControl(name) {
  return process.argv.includes("--enable-test-fault-injection")
    ? process.env[name]
    : undefined;
}

function collectFiles(rootPath, files = new Map()) {
  if (!existsSync(rootPath)) {
    return files;
  }

  const entry = statSync(rootPath);
  if (entry.isFile()) {
    files.set(relative(workspaceRoot, rootPath), readFileSync(rootPath));
    return files;
  }

  for (const child of readdirSync(rootPath)) {
    collectFiles(join(rootPath, child), files);
  }
  return files;
}

function snapshotGeneratedFiles() {
  const files = new Map();
  for (const generatedPath of generatedPaths) {
    collectFiles(join(workspaceRoot, generatedPath), files);
  }
  return files;
}

function findDifferences(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().filter((path) => {
    const previous = before.get(path);
    const current = after.get(path);
    return !previous || !current || !previous.equals(current);
  });
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function attempt(step, action, failures) {
  try {
    action();
  } catch (error) {
    failures.push({ step, error });
  }
}

let testSignalTriggered = false;

function triggerTestSignal(checkpoint) {
  if (
    !testSignalTriggered &&
    getTestFaultControl("API_CODEGEN_CHECK_TEST_SIGNAL_AT") === checkpoint
  ) {
    testSignalTriggered = true;
    process.kill(process.pid, "SIGTERM");
  }
}

function backUpGeneratedPaths(destination) {
  const backups = new Map();
  for (const generatedPath of generatedPaths) {
    const source = join(workspaceRoot, generatedPath);
    if (existsSync(source)) {
      const backup = join(destination, generatedPath);
      cpSync(source, backup, { recursive: true });
      backups.set(generatedPath, backup);
      triggerTestSignal("backup");
    }
  }
  return backups;
}

function describeDrift(before, after, paths) {
  try {
    const testRenderingError = getTestFaultControl(
      "API_CODEGEN_CHECK_TEST_RENDERING_ERROR",
    );
    if (testRenderingError !== undefined) {
      throw new Error(testRenderingError);
    }
    return formatDriftReport({ before, after, paths });
  } catch (error) {
    // The diff is explanatory only; a rendering problem must not hide the
    // drift itself. Keep the fallback fixed-size rather than listing every
    // path, because the fallback is part of the same bounded CI failure.
    const detail = describeError(error).replace(/\s+/g, " ").slice(0, 240);
    return [
      "Generated API drift detected after regeneration:",
      "",
      `${paths.length} generated file(s) changed.`,
      `(Unable to render the bounded regeneration diff: ${detail})`,
      "",
      `Run \`${regenerationCommand}\` and commit the generated output.`,
    ].join("\n");
  }
}

function markdownFence(text) {
  const longestBacktickRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function appendDriftSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const fence = markdownFence(report);
  try {
    appendFileSync(
      summaryPath,
      [
        "## Generated API drift detected",
        "",
        `Regenerate with \`${regenerationCommand}\` and commit the generated output.`,
        "",
        `${fence}diff`,
        report,
        fence,
        "",
      ].join("\n"),
    );
  } catch (error) {
    console.error(
      `Could not write the GitHub step summary at ${summaryPath}: ${describeError(error)}`,
    );
  }
}

function restoreGeneratedPaths(backups) {
  const failures = [];
  for (const generatedPath of generatedPaths) {
    const target = join(workspaceRoot, generatedPath);
    attempt(
      `Removing regenerated output at ${generatedPath}`,
      () => rmSync(target, { recursive: true, force: true }),
      failures,
    );
    triggerTestSignal("restore");

    const backup = backups.get(generatedPath);
    if (backup) {
      attempt(
        `Restoring ${generatedPath} from its backup`,
        () => cpSync(backup, target, { recursive: true }),
        failures,
      );
    }
  }
  return failures;
}

function removeTemporaryDirectory(temporaryDirectory) {
  const failures = [];
  triggerTestSignal("cleanup");
  attempt(
    `Removing the temporary backup directory ${temporaryDirectory}`,
    () => {
      if (
        getTestFaultControl("API_CODEGEN_CHECK_TEST_FAIL_CLEANUP") === "1"
      ) {
        throw new Error("simulated temporary-directory removal failure");
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
    failures,
  );
  return failures;
}

function reportFailures(heading, failures) {
  console.error(heading);
  for (const { step, error } of failures) {
    console.error(`- ${step} failed: ${describeError(error)}`);
  }
}

function findLeftoverBackupDirectories() {
  // Deliberately do not add this prefix to .gitignore. A leftover backup can
  // contain the only copy of local edits, so seeing it in git status is a
  // useful recovery signal and helps prevent it from being forgotten.
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(backupDirectoryPrefix),
    )
    .map((entry) => join(workspaceRoot, entry.name))
    .sort();
}

const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
};
const testTerminationGraceSetting = getTestFaultControl(
  "API_CODEGEN_CHECK_TERMINATION_GRACE_MS",
);

function getTerminationGraceMs() {
  if (testTerminationGraceSetting === undefined) {
    return 5000;
  }

  const terminationGraceMs = Number(testTerminationGraceSetting);
  if (
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs <= 0
  ) {
    throw new Error(
      "API_CODEGEN_CHECK_TERMINATION_GRACE_MS must be a positive integer when test fault injection is enabled.",
    );
  }
  return terminationGraceMs;
}

// Give codegen five seconds to handle an interrupt and exit cleanly before
// forcing it to stop so generated-file restoration cannot wait forever.
const terminationGraceMs = getTerminationGraceMs();

function createCancellationController() {
  let interruptedSignal;
  let child;
  let forcedTermination;
  let terminationTimer;
  const codegenGroupIsRunning = () => {
    if (!child?.pid || process.platform === "win32") {
      return child?.exitCode === null && child?.signalCode === null;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };
  const killCodegen = (signal) => {
    if (!child?.pid) {
      return;
    }
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    try {
      // Codegen is detached into its own process group so pnpm and every
      // command it launches stop before generated files are restored.
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };
  const interruptChild = () => {
    if (!child || !interruptedSignal || !codegenGroupIsRunning()) {
      return;
    }
    killCodegen(interruptedSignal);
    terminationTimer ??= setTimeout(() => {
      if (codegenGroupIsRunning()) {
        console.error(
          `Codegen did not exit within ${terminationGraceMs}ms after ${interruptedSignal}; forcing termination with SIGKILL.`,
        );
        killCodegen("SIGKILL");
        // SIGKILL cannot be handled. Once it has been delivered to the
        // process group, no member can write generated output during restore.
        forcedTermination?.();
      }
    }, terminationGraceMs);
  };
  const signalHandlers = Object.fromEntries(
    Object.keys(signalExitCodes).map((signal) => [
      signal,
      () => {
        interruptedSignal ??= signal;
        interruptChild();
      },
    ]),
  );
  for (const [signal, handler] of Object.entries(signalHandlers)) {
    process.on(signal, handler);
  }

  return {
    get interruptedSignal() {
      return interruptedSignal;
    },
    codegenGroupIsRunning,
    setChild(nextChild, onForcedTermination) {
      child = nextChild;
      forcedTermination = onForcedTermination;
      interruptChild();
    },
    clearChild() {
      clearTimeout(terminationTimer);
      terminationTimer = undefined;
      forcedTermination = undefined;
      child = undefined;
    },
    dispose() {
      for (const [signal, handler] of Object.entries(signalHandlers)) {
        process.off(signal, handler);
      }
    },
  };
}

function yieldToSignals() {
  return new Promise((resolveYield) => setTimeout(resolveYield, 0));
}

function runCodegen(cancellation) {
  return new Promise((resolveRun) => {
    let settled = false;
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/api-spec", "run", "codegen"],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
        detached: process.platform !== "win32",
      },
    );

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation.clearChild();
      resolveRun(result);
    };
    cancellation.setChild(child, () => finish({ signal: "SIGKILL" }));

    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => {
      if (
        cancellation.interruptedSignal &&
        cancellation.codegenGroupIsRunning()
      ) {
        return;
      }
      finish({ code, signal });
    });
  });
}

async function main() {
  if (process.env.API_CODEGEN_CHECK_WORKSPACE && !testWorkspaceEnabled) {
    console.error(
      "Refusing API_CODEGEN_CHECK_WORKSPACE without the explicit --enable-test-workspace test subprocess opt-in.",
    );
    console.error("No generated files were changed.");
    return 1;
  }

  let stagedBackupDirectories;
  try {
    stagedBackupDirectories = findStagedBackupDirectories(workspaceRoot);
  } catch (error) {
    console.error(
      `Could not check the Git index for generated-client recovery backups: ${describeError(error)}`,
    );
    console.error("No generated files were changed.");
    return 1;
  }

  if (stagedBackupDirectories.length > 0) {
    reportStagedBackupDirectories(stagedBackupDirectories, {
      heading:
        "Refusing to check generated API clients because recovery backup directories are staged:",
    });
    console.error("No generated files were changed.");
    return 1;
  }

  let leftoverBackupDirectories;
  try {
    leftoverBackupDirectories = findLeftoverBackupDirectories();
  } catch (error) {
    console.error(
      `Could not check for leftover generated-client backups: ${describeError(error)}`,
    );
    console.error("No generated files were changed.");
    return 1;
  }

  if (leftoverBackupDirectories.length > 0) {
    console.error(
      "Refusing to check generated API clients because leftover backup directories exist:",
    );
    for (const directory of leftoverBackupDirectories) {
      console.error(`- ${directory}`);
    }
    console.error(
      "Recover any needed files by copying them back into the workspace, then delete each backup directory and re-run this check.",
    );
    console.error("No generated files were changed.");
    return 1;
  }

  let temporaryDirectory;
  try {
    temporaryDirectory = mkdtempSync(
      join(workspaceRoot, backupDirectoryPrefix),
    );
  } catch (error) {
    console.error(
      `Could not create a temporary backup directory for the generated API clients: ${describeError(error)}`,
    );
    console.error("No generated files were changed.");
    return 1;
  }

  const cancellation = createCancellationController();
  let backups;
  let before;
  try {
    backups = backUpGeneratedPaths(temporaryDirectory);
    before = snapshotGeneratedFiles();
    await yieldToSignals();
  } catch (error) {
    console.error(
      `Could not back up the generated API clients before regeneration: ${describeError(error)}`,
    );
    console.error("No generated files were changed.");
    const cleanupFailures = removeTemporaryDirectory(temporaryDirectory);
    if (cleanupFailures.length > 0) {
      reportFailures(
        "Cleanup after the failed backup did not finish:",
        cleanupFailures,
      );
      console.error(`Delete ${temporaryDirectory} manually.`);
    }
    await yieldToSignals();
    const interruptedSignal = cancellation.interruptedSignal;
    cancellation.dispose();
    return interruptedSignal ? signalExitCodes[interruptedSignal] : 1;
  }

  const codegenResult = cancellation.interruptedSignal
    ? {}
    : await runCodegen(cancellation);
  const codegenError =
    codegenResult.error ??
    (codegenResult.code || codegenResult.signal
      ? new Error(
          codegenResult.signal
            ? `Codegen was terminated by ${codegenResult.signal}.`
            : `Codegen exited with status ${codegenResult.code}.`,
        )
      : undefined);

  let after;
  let differences = [];
  let comparisonError;
  try {
    after = snapshotGeneratedFiles();
    triggerTestSignal("comparison");
    differences = findDifferences(before, after);
  } catch (error) {
    comparisonError = error;
  }

  // Restoration always runs once codegen has been attempted, and every step is
  // tried even if an earlier one fails so as much as possible is put back.
  const restoreFailures = restoreGeneratedPaths(backups);
  const restored = restoreFailures.length === 0;
  // The backup is the only remaining copy of the original files when
  // restoration fails, so it is only removed after a complete restoration.
  const keepBackup = !restored && backups.size > 0;
  const cleanupFailures = keepBackup
    ? []
    : removeTemporaryDirectory(temporaryDirectory);
  await yieldToSignals();
  const interruptedSignal = cancellation.interruptedSignal;
  cancellation.dispose();

  let exitCode = 0;
  if (interruptedSignal) {
    console.error(
      restored
        ? `API client regeneration was interrupted by ${interruptedSignal}; generated files were restored to their original state.`
        : `API client regeneration was interrupted by ${interruptedSignal}.`,
    );
    exitCode = signalExitCodes[interruptedSignal];
  } else if (codegenError) {
    console.error(
      restored
        ? "API client regeneration failed; generated files were restored to their original state."
        : "API client regeneration failed.",
    );
    exitCode = codegenResult.code || 1;
  } else if (comparisonError) {
    console.error(
      `Could not read the regenerated API clients to compare them: ${describeError(comparisonError)}`,
    );
    exitCode = 1;
  } else if (differences.length > 0) {
    // The diff is rendered from the in-memory snapshots, after restoration.
    const driftReport = describeDrift(before, after, differences);
    console.error(driftReport);
    appendDriftSummary(driftReport);
    exitCode = 1;
  }

  if (!restored) {
    reportFailures(
      "Could not restore the generated API clients after regeneration:",
      restoreFailures,
    );
    if (keepBackup) {
      console.error(
        `Your original generated files are preserved in ${temporaryDirectory}. Copy them back into place, then delete that directory.`,
      );
    }
    exitCode ||= 1;
  }

  if (cleanupFailures.length > 0) {
    reportFailures(
      "Cleanup after checking the generated API clients did not finish:",
      cleanupFailures,
    );
    console.error(`Delete ${temporaryDirectory} manually.`);
    exitCode ||= 1;
  }

  if (exitCode === 0) {
    console.log("Generated API clients match the OpenAPI specification.");
  }
  return exitCode;
}

process.exit(await main());
