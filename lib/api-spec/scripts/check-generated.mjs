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

const workspaceRoot = resolve(
  process.env.API_CODEGEN_CHECK_WORKSPACE ??
    fileURLToPath(new URL("../../..", import.meta.url)),
);
const backupDirectoryPrefix = ".api-codegen-check-";
const generatedPaths = [
  "lib/api-client-react/src/generated",
  "lib/api-zod/src/generated",
  "lib/api-zod/src/index.ts",
];

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

function backUpGeneratedPaths(destination) {
  const backups = new Map();
  for (const generatedPath of generatedPaths) {
    const source = join(workspaceRoot, generatedPath);
    if (existsSync(source)) {
      const backup = join(destination, generatedPath);
      cpSync(source, backup, { recursive: true });
      backups.set(generatedPath, backup);
    }
  }
  return backups;
}

function describeDrift(before, after, paths) {
  try {
    return formatDriftReport({ before, after, paths });
  } catch (error) {
    // The diff is explanatory only; a rendering problem must not hide the
    // drift itself, so fall back to the plain path list and say why.
    return [
      ...paths.map((path) => `- ${path}`),
      `(Unable to render the regeneration diff: ${describeError(error)})`,
    ].join("\n");
  }
}

function appendDriftSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  appendFileSync(
    summaryPath,
    `## Generated API drift detected\n\n\`\`\`diff\n${report}\n\`\`\`\n`,
  );
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
  attempt(
    `Removing the temporary backup directory ${temporaryDirectory}`,
    () => rmSync(temporaryDirectory, { recursive: true, force: true }),
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

function runCodegen() {
  return new Promise((resolveRun) => {
    let interruptedSignal;
    let settled = false;
    let child;
    const signalHandlers = Object.fromEntries(
      Object.keys(signalExitCodes).map((signal) => [
        signal,
        () => {
          interruptedSignal ??= signal;
          if (
            child &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            child.kill(signal);
          }
        },
      ]),
    );
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      process.on(signal, handler);
    }

    child = spawn(
      "pnpm",
      ["--filter", "@workspace/api-spec", "run", "codegen"],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );

    if (interruptedSignal) {
      child.kill(interruptedSignal);
    }

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const [signal, handler] of Object.entries(signalHandlers)) {
        process.off(signal, handler);
      }
      resolveRun({ ...result, interruptedSignal });
    };

    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function main() {
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
    temporaryDirectory = mkdtempSync(join(workspaceRoot, backupDirectoryPrefix));
  } catch (error) {
    console.error(
      `Could not create a temporary backup directory for the generated API clients: ${describeError(error)}`,
    );
    console.error("No generated files were changed.");
    return 1;
  }

  let backups;
  let before;
  try {
    backups = backUpGeneratedPaths(temporaryDirectory);
    before = snapshotGeneratedFiles();
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
    return 1;
  }

  const codegenResult = await runCodegen();
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

  let exitCode = 0;
  if (codegenResult.interruptedSignal) {
    console.error(
      restored
        ? `API client regeneration was interrupted by ${codegenResult.interruptedSignal}; generated files were restored to their original state.`
        : `API client regeneration was interrupted by ${codegenResult.interruptedSignal}.`,
    );
    exitCode = signalExitCodes[codegenResult.interruptedSignal];
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
    console.error("Generated API drift detected after regeneration:");
    console.error(driftReport);
    appendDriftSummary(driftReport);
    console.error("");
    console.error(
      "Run `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.",
    );
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
