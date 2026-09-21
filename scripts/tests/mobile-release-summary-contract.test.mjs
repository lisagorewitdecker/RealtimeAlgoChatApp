/**
 * Contract test for the mobile release summary path.
 *
 * GitHub masks a secret in logs and step summaries only when the exact value
 * was registered in the same job. Values that reach a summary through evidence
 * artifacts, another job, or a transformation render as-is. Candidate build
 * IDs are intentionally non-secret; private app IDs and smoke-account values
 * are kept out of every summary surface by construction.
 * This test locks in four guarantees:
 *
 *   1. The release workflow hands secrets to steps only through `env`, and the
 *      inline steps that write the step summary can neither see nor
 *      interpolate them.
 *   2. Every script the workflow invokes (directly, through package scripts, or
 *      transitively) that writes `GITHUB_STEP_SUMMARY` is listed in an explicit
 *      inventory with a contract; a new summary writer fails until covered.
 *   3. Each inventoried script's diagnostics are fixed text, credentials are
 *      only ever exported by name, and its summary never carries private
 *      values.
 *   4. Private app IDs stay inside uploaded evidence artifacts. Non-secret
 *      candidate build IDs may appear in the branding summary.
 *   5. A partial native rerun can replace one platform's artifact without
 *      changing the other platform's fixed report link.
 *   6. A failed platform artifact download keeps the release blocked without
 *      hiding the other platform's report link.
 *   7. Mixed record-only, sidecar-only, and paired Android preview changes are
 *      validated independently in deterministic path order; one failure does
 *      not hide valid records, break sidecar pairing, or expose evidence text.
 *   8. Malformed, schema-invalid, and duplicate Android and iOS preflight
 *      artifacts fail with the fixed redacted-schema message without
 *      exposing their markers or raw artifact content.
 *   9. A missing Android or iOS preflight validator produces a fixed
 *      dependency diagnostic without running the checker or exposing evidence
 *      content.
 *  10. A failed artifact extraction clears partial platform output before its
 *      retry, while a permanently missing artifact still reaches the fixed
 *      platform-specific blocking summary.
 *  11. A controlled hosted artifact outage recovers only after the retry
 *      succeeds, while a failed retry still blocks native evidence.
 *  12. Native report artifacts use the maximum bounded retention window, and
 *      an expired artifact download never leaves a dead report link in the
 *      release summary.
 *  13. A hosted cleanup failure skips the native retry, preserves stale output,
 *      and still publishes the fixed redacted platform recovery summary.
 *  14. A failed native privacy check still writes a BLOCKED publish summary
 *      without reaching the simulated store submission boundary.
 *  15. Successful native downloads with malformed artifact URLs keep both
 *      platform statuses fixed while omitting unsafe report links.
 *  16. A failed continue-on-error download remains blocked when its visible
 *      step conclusion is successful, and the diagnostic explains why.
 *
 * The static rules catch code paths no scenario exercises; the behavioral runs
 * inject sentinel values for every secret-backed variable and prove the real
 * scripts keep them out of every log and summary surface.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/mobile-release.yml",
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const playwrightConfig = readFileSync(
  path.join(workspaceRoot, "artifacts/api-server/e2e/playwright.config.ts"),
  "utf8",
);
const bashPath = locateExecutable("bash");
const gitPath = locateExecutable("git");
const androidRunnerPins = readFileSync(
  path.join(workspaceRoot, "scripts/android-runner-pins.sh"),
  "utf8",
);
const androidBuildToolsVersion = androidRunnerPins.match(
  /^ANDROID_BUILD_TOOLS_VERSION="([^"]+)"$/m,
)?.[1];
assert.ok(
  androidBuildToolsVersion,
  "the Android runner pin contract must define ANDROID_BUILD_TOOLS_VERSION",
);

const iosGateScript = "artifacts/chat-app/e2e/native-large-text/run.sh";
const iosPreflightScript = "scripts/check-ios-release-prerequisites.sh";
const androidPreflightScript = "scripts/check-android-release-prerequisites.sh";
const nativeEvidenceCheckerScript =
  "scripts/check-native-large-text-evidence.sh";
const nativeReleaseArchiveScript =
  "scripts/archive-native-release-report.sh";
const untrustedCheckerWrapperScript = "scripts/run-untrusted-checker.sh";
const workflowOutputSafetyScript = "scripts/workflow-output-safety.sh";
const nativeBrandingSummaryScript = "scripts/summarize-native-branding.sh";
const nativeRecoveryContractScript =
  "scripts/native-release-recovery-contract.sh";
const pinnedUploadArtifactAction =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const pinnedDownloadArtifactAction =
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";

const recoveryContractResult = spawnSync(
  bashPath,
  [
    "-c",
    'source "$1"; native_release_recovery_line ios; native_release_recovery_line android',
    "native-release-recovery-contract",
    path.join(workspaceRoot, nativeRecoveryContractScript),
  ],
  { cwd: workspaceRoot, encoding: "utf8" },
);
assert.equal(
  recoveryContractResult.status,
  0,
  "the native recovery contract must load successfully",
);
const nativeRecoveryLines = recoveryContractResult.stdout.trimEnd().split("\n");
assert.deepEqual(
  nativeRecoveryLines,
  [
    "- Recovery: **Rerun the iOS native large-text job, or make the existing iOS artifact available, then rerun the mobile release gate.**",
    "- Recovery: **Rerun the Android native large-text job, or make the existing Android artifact available, then rerun the mobile release gate.**",
  ],
  "the native recovery contract must keep both fixed, safe recovery lines",
);
const [iosRecoveryLine, androidRecoveryLine] = nativeRecoveryLines;
/**
 * Inventory of every script invoked by the release workflow that writes
 * `GITHUB_STEP_SUMMARY`. The discovery test fails when the workflow gains a
 * summary writer that is missing here, or when an entry goes stale.
 *
 * `diagnosticVariableAllowlist` names the runtime values a diagnostic may
 * interpolate. Script constants assigned a literal exactly once (see
 * scriptConstants) are fixed text and therefore also allowed. Extend an
 * allowlist only after confirming the new value cannot carry a release
 * identifier or smoke-account data, because diagnostics are copied verbatim
 * into the step summary.
 */
const scriptContracts = {
  [iosGateScript]: {
    diagnosticFunction: "record_ios_readiness_failure",
    diagnosticVariableAllowlist: ["command", "BOOTED_DEVICE"],
    summaryFunction: "write_ios_readiness_summary",
    // Audited candidate identifiers may be written to evidence files here.
    evidenceDirectoryVariable: "RESULTS_DIR",
  },
  [iosPreflightScript]: {
    diagnosticFunction: "record_failure",
    diagnosticVariableAllowlist: [
      "command",
      "name",
      "java_version",
      "pnpm_version",
      "PNPM_VERSION",
      // These are fixed, non-secret values from the shared iOS runner
      // contract. They are safe to copy into bounded diagnostics.
      "IOS_RUNNER_PNPM_VERSION",
      "IOS_RUNNER_JAVA_MINIMUM_MAJOR",
      "IOS_RUNNER_SIMULATOR_NAME",
    ],
    summaryFunction: "write_summary",
    evidenceDirectoryVariable: null,
  },
  [androidPreflightScript]: {
    diagnosticFunction: "record_failure",
    diagnosticVariableAllowlist: [
      "command",
      "name",
      "java_version",
      "SDK_ROOT",
      "wait_seconds",
      "width_dp",
      "height_dp",
      "rotation",
    ],
    summaryFunction: "write_summary",
    // The preflight uploads no evidence, so identifiers may only feed tools.
    evidenceDirectoryVariable: null,
  },
  "scripts/check-android-release-runner-health.sh": {
    diagnosticFunction: "record_failure",
    diagnosticVariableAllowlist: ["required_label_text"],
    summaryFunction: "write_report",
    evidenceDirectoryVariable: null,
    requiresPrivateValues: false,
  },
  "scripts/check-native-large-text-evidence.sh": {
    diagnosticFunction: "record_summary_issue",
    diagnosticVariableAllowlist: ["platform"],
    summaryFunction: "write_evidence_summary",
    evidenceDirectoryVariable: null,
    requiresPrivateValues: false,
  },
  "scripts/summarize-native-branding.sh": {
    diagnosticFunction: "report_error",
    diagnosticVariableAllowlist: ["PLATFORM"],
    summaryFunction: "write_summary",
    evidenceDirectoryVariable: null,
    requiresPrivateValues: false,
  },
};

/**
 * Inventory of JSON readers that consume release evidence. The source scan
 * below intentionally discovers JSON.parse calls in release-check scripts and
 * their local helper modules rather than trusting this list alone: adding a
 * reader without adding the shared duplicate-key check must fail this
 * contract. An entry script that reaches several readers (its own and those
 * of the local helpers it imports) lists one contract per parsed argument.
 */
const releaseEvidenceReaderContracts = {
  "artifacts/chat-app/scripts/validate-branding.mjs": {
    name: "native branding metadata",
    argument: "source",
    scannerCall: "findDuplicateJsonObjectKeys(source)",
    duplicateFailure: /Native \$\{platformLabel\(platform\)\} metadata contains duplicate fields/,
  },
  "artifacts/chat-app/scripts/validate-preview-startup.mjs": [
    {
      name: "preview handoff sidecar",
      argument: "source",
      scannerCall: "findDuplicateJsonObjectKeys(source)",
      duplicateFailure: /Preview handoff preflight JSON contains duplicate fields/,
    },
    {
      // The preflight copies the launch-evidence probe result and start
      // record through preview-launch-evidence.mjs, so that helper's reader
      // is reached from this entry script.
      name: "iOS launch-evidence probe records",
      argument: "contents",
      scannerCall: "findDuplicateJsonObjectKeys(contents)",
      duplicateFailure: /Launch-evidence probe JSON contains duplicate fields \(\$\{fileName\}\)\./,
    },
  ],
  "scripts/check-native-large-text-evidence.sh": {
    name: "native large-text Sentry evidence",
    argument: "rawEvidence",
    scannerCall: "findDuplicateJsonObjectKeys(rawEvidence)",
    duplicateFailure: /throw new Error\("duplicate JSON field\(s\)"\)/,
  },
  "scripts/verify-sentry-native-event.mjs": {
    name: "saved Sentry source-map evidence",
    argument: "rawEvidence",
    scannerCall: "findDuplicateJsonObjectKeys(rawEvidence)",
    duplicateFailure: /throw new Error\("duplicate JSON field\(s\)"\)/,
  },
};

const releaseEvidenceSourceDirectories = [
  path.join(workspaceRoot, "artifacts/chat-app/scripts"),
  path.join(workspaceRoot, "scripts"),
];
const releaseEvidenceExcludedDirectoryNames = new Set([
  "__tests__",
  "fixture",
  "fixtures",
  "node_modules",
  "test",
  "test-fixtures",
  "tests",
  "tooling",
  "tools",
]);
const releaseEvidenceExcludedDirectories = new Set([
  path.join(workspaceRoot, "scripts/src"),
  path.join(workspaceRoot, "scripts/tests"),
]);
const releaseEvidenceScriptPattern = /\.(?:mjs|sh)$/;
const releaseEvidenceExcludedFilePattern =
  /\.(?:fixture|test)\.(?:mjs|sh)$/;

const nonEvidenceJsonParseArguments = {
  "artifacts/chat-app/scripts/validate-branding.mjs": new Set([
    "appMetadataSource",
  ]),
  "artifacts/chat-app/scripts/validate-preview-startup.mjs": new Set([
    "body",
    "manifestBody",
  ]),
  "scripts/validate-mockup-clean.mjs": new Set(["listOutput"]),
  // Tracked package manifests are repository source, not evidence produced by
  // a release run, so this reader is outside the evidence duplicate-field
  // contract.
  "scripts/validate-package-manifests.mjs": new Set(["source"]),
};

const shellHereDocPattern =
  /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_-]*)['"]?\s*\n([\s\S]*?)\n\1(?=\n|$)/g;
const shellDynamicImportPattern =
  /\bimport\s*\(\s*pathToFileURL\(\s*([A-Za-z_$][\w$]*)\s*\)\.href\s*\)/g;
const processArgDestructurePattern =
  /\b(?:const|let|var)\s*\[([\s\S]*?)\]\s*=\s*process\.argv\b/g;
const MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH = 4;

const actionExpressionPattern = /\$\{\{([\s\S]*?)\}\}/g;
const secretExpressionPattern = /\bsecrets\s*[.[]|\bgithub\.token\b/;
const xtracePattern =
  /(^|[\s;&|(])(set\s+(-[a-zA-Z]*x|-o\s+xtrace)|bash\s+-[a-zA-Z]*x)/m;
const indirectExpansionPattern = /\$\{!/;
const environmentDumpPatterns = [
  /(^|[\s;&|(])printenv\b/m,
  /(^|[\s;&|(])(declare\s+-p|export\s+-p|compgen\s+-e)(\s|$)/m,
  /(^|[\s;&|(])env\s*($|[|>;&])/m,
];

// ---------------------------------------------------------------------------
// Workflow model
// ---------------------------------------------------------------------------

function locateExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  throw new Error(`Could not locate "${name}" on PATH.`);
}

function stringEntries(record) {
  return Object.entries(record ?? {}).map(([key, value]) => [
    key,
    value == null ? "" : String(value),
  ]);
}

function variableReferencePattern(name) {
  return new RegExp(String.raw`\$\{?${name}\b`);
}

function secretSourceOf(value) {
  const match = String(value).match(
    /\bsecrets\s*(?:\.|\[\s*['"])([A-Za-z0-9_]+)/,
  );
  return match?.[1] ?? null;
}

function listSteps() {
  const steps = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    (job.steps ?? []).forEach((step, index) => {
      steps.push({
        jobId,
        job,
        step,
        index: index + 1,
        label: `${jobId} step ${index + 1} (${
          step.name ?? step.id ?? step.uses ?? "unnamed"
        })`,
        env: {
          ...(workflow.env ?? {}),
          ...(job.env ?? {}),
          ...(step.env ?? {}),
        },
      });
    });
  }
  return steps;
}

/** Every environment variable name that is mapped from a secret anywhere. */
function collectSecretBearingEnv() {
  const names = new Map();
  const record = (env) => {
    for (const [name, value] of stringEntries(env)) {
      if (!secretExpressionPattern.test(value)) {
        continue;
      }
      if (!names.has(name)) {
        names.set(name, new Set());
      }
      names.get(name).add(secretSourceOf(value) ?? "github.token");
    }
  };
  record(workflow.env);
  for (const job of Object.values(workflow.jobs ?? {})) {
    record(job.env);
    for (const step of job.steps ?? []) {
      record(step.env);
    }
  }
  return names;
}

const identifierSourcePattern = /_(?:BUILD|APP)_ID$/;
const credentialSourcePattern = /PASSWORD|EMAIL|TOKEN|SECRET|KEY/;

/**
 * Audited identifiers may be recorded in uploaded evidence; credentials may
 * never be expanded; every other private value may only feed tools directly.
 */
function classifySecretSource(source) {
  if (identifierSourcePattern.test(source)) {
    return "identifier";
  }
  if (credentialSourcePattern.test(source)) {
    return "credential";
  }
  return "private";
}

const allSteps = listSteps();
const secretBearingEnv = collectSecretBearingEnv();
const directSummarySteps = allSteps.filter(
  ({ step }) =>
    typeof step.run === "string" && step.run.includes("GITHUB_STEP_SUMMARY"),
);

function assertNoProblems(problems, heading) {
  assert.equal(
    problems.length,
    0,
    [heading, ...problems.map((problem) => `  - ${problem}`)].join("\n"),
  );
}

const localModuleImportPatterns = [
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const localModuleExtensions = [
  "",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

function resolveLocalModule(filePath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const modulePath = path.resolve(path.dirname(filePath), specifier);
  const candidates = [
    ...localModuleExtensions.map((extension) => `${modulePath}${extension}`),
    ...localModuleExtensions.map((extension) =>
      path.join(modulePath, `index${extension}`),
    ),
  ];

  for (const candidate of candidates) {
    if (
      candidate.startsWith(`${workspaceRoot}${path.sep}`) &&
      !candidate.includes(`${path.sep}node_modules${path.sep}`) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
}

function tokenizeShellArguments(text) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;

  const pushToken = () => {
    if (token !== "") {
      tokens.push(token);
      token = "";
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      if (character !== "\n") {
        token += character;
      }
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      token += character;
    }
  }
  if (escaped) {
    token += "\\";
  }
  pushToken();
  return tokens;
}

function heredocCommand(source, heredocStart) {
  let commandStart = source.lastIndexOf("\n", heredocStart - 1) + 1;
  while (commandStart > 0) {
    const previousLineEnd = commandStart - 1;
    const previousLineStart = source.lastIndexOf("\n", previousLineEnd - 1) + 1;
    if (
      !source.slice(previousLineStart, previousLineEnd).trimEnd().endsWith("\\")
    ) {
      break;
    }
    commandStart = previousLineStart;
  }
  return source.slice(commandStart, heredocStart);
}

function resolveShellPathToken(filePath, token) {
  const relative = token
    .replace(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/+/, "")
    .replace(/^\.\//, "");
  if (!relative || /[$'"{}]/.test(relative) || path.isAbsolute(relative)) {
    return null;
  }

  for (const base of [path.dirname(filePath), workspaceRoot]) {
    const candidate = path.resolve(base, relative);
    if (
      candidate.startsWith(`${workspaceRoot}${path.sep}`) &&
      !candidate.includes(`${path.sep}node_modules${path.sep}`) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
}

/** Contracts registered for an entry script, one per parsed argument. */
function releaseEvidenceReaderContractsFor(relativePath) {
  const contracts = releaseEvidenceReaderContracts[relativePath];
  if (contracts === undefined) {
    return [];
  }
  return Array.isArray(contracts) ? contracts : [contracts];
}

function discoverShellEmbeddedLocalModules(filePath) {
  const relativePath = path.relative(workspaceRoot, filePath);
  const [shellContract] = releaseEvidenceReaderContractsFor(relativePath);
  if (!filePath.endsWith(".sh") || !shellContract) {
    return [];
  }

  const source = readFileSync(filePath, "utf8");
  const importedPaths = new Set();
  for (const match of source.matchAll(shellHereDocPattern)) {
    const body = match[2];
    const dynamicImportVariables = [
      ...body.matchAll(shellDynamicImportPattern),
    ].map(([, variable]) => variable);
    if (dynamicImportVariables.length === 0) {
      continue;
    }

    const processArgumentIndexes = new Map();
    for (const destructure of body.matchAll(processArgDestructurePattern)) {
      destructure[1].split(",").forEach((part, index) => {
        const variable = part.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(variable)) {
          processArgumentIndexes.set(variable, index);
        }
      });
    }

    const commandTokens = tokenizeShellArguments(
      heredocCommand(source, match.index),
    );
    const dashIndex = commandTokens.findIndex(
      (token, index) =>
        token === "-" &&
        index > 0 &&
        commandTokens
          .slice(0, index)
          .some(
            (candidate) =>
              /(?:^|\/)node$/.test(candidate) ||
              candidate.includes("NODE_BINARY"),
          ),
    );
    if (dashIndex < 0) {
      continue;
    }

    for (const variable of dynamicImportVariables) {
      const processArgumentIndex = processArgumentIndexes.get(variable);
      if (processArgumentIndex === undefined) {
        continue;
      }
      // Node's process.argv contains the executable and "-" before the
      // arguments supplied to a stdin script.
      const argumentToken =
        commandTokens[dashIndex + 1 + processArgumentIndex - 2];
      const importedPath = argumentToken
        ? resolveShellPathToken(filePath, argumentToken)
        : null;
      if (importedPath) {
        importedPaths.add(importedPath);
      }
    }
  }
  return [...importedPaths];
}

function discoverLocalModuleClosure(entryPath) {
  const discovered = new Set();
  const queue = [entryPath];

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (discovered.has(filePath)) {
      continue;
    }
    discovered.add(filePath);

    if (!/\.(?:mjs|js|cjs|ts|tsx|mts|cts)$/.test(filePath)) {
      for (const importedPath of discoverShellEmbeddedLocalModules(filePath)) {
        if (!discovered.has(importedPath)) {
          queue.push(importedPath);
        }
      }
      continue;
    }

    const source = readFileSync(filePath, "utf8");
    for (const pattern of localModuleImportPatterns) {
      for (const [, specifier] of source.matchAll(pattern)) {
        const importedPath = resolveLocalModule(filePath, specifier);
        if (importedPath && !discovered.has(importedPath)) {
          queue.push(importedPath);
        }
      }
    }
  }

  return discovered;
}

function jsonParseMatches(filePath) {
  const parsePattern = /\bJSON\.parse\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  const relativePath = path.relative(workspaceRoot, filePath);
  const ignoredArguments =
    nonEvidenceJsonParseArguments[relativePath] ?? new Set();
  const [shellContract] = releaseEvidenceReaderContractsFor(relativePath);
  const source = readFileSync(filePath, "utf8");

  return [...source.matchAll(parsePattern)]
    .map(([, argument]) => argument)
    .filter((argument) => !ignoredArguments.has(argument))
    .filter(
      (argument) =>
        !filePath.endsWith(".sh") ||
        (shellContract && argument === shellContract.argument),
    )
    .map((argument) => ({ filePath, argument }));
}

function releaseCheckEntryPaths() {
  const entries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          releaseEvidenceExcludedDirectoryNames.has(entry.name) ||
          releaseEvidenceExcludedDirectories.has(filePath)
        ) {
          continue;
        }
        visit(filePath);
        continue;
      }

      if (
        !entry.isFile() ||
        !releaseEvidenceScriptPattern.test(entry.name) ||
        releaseEvidenceExcludedFilePattern.test(entry.name)
      ) {
        continue;
      }

      const relativePath = path.relative(workspaceRoot, filePath);
      if (relativePath === "scripts/find-duplicate-json-object-keys.mjs") {
        continue;
      }
      entries.push(filePath);
    }
  }

  for (const directory of releaseEvidenceSourceDirectories) {
    visit(directory);
  }

  return entries;
}

function discoverReleaseEvidenceJsonParses(
  entryFilePaths = releaseCheckEntryPaths(),
) {
  const importedHelpers = new Set();
  const closures = new Map();

  for (const entryFilePath of entryFilePaths) {
    const closure = discoverLocalModuleClosure(entryFilePath);
    closures.set(entryFilePath, closure);
    for (const importedPath of closure) {
      if (importedPath !== entryFilePath) {
        importedHelpers.add(importedPath);
      }
    }
  }

  const discovered = [];
  for (const [entryFilePath, closure] of closures) {
    if (importedHelpers.has(entryFilePath)) {
      continue;
    }

    const entryPath = path.relative(workspaceRoot, entryFilePath);
    for (const filePath of closure) {
      if (
        path.relative(workspaceRoot, filePath) ===
        "scripts/find-duplicate-json-object-keys.mjs"
      ) {
        continue;
      }
      for (const match of jsonParseMatches(filePath)) {
        discovered.push({
          entryPath,
          parserPath: path.relative(workspaceRoot, match.filePath),
          argument: match.argument,
        });
      }
    }
  }

  return discovered.sort((left, right) =>
    `${left.entryPath}::${left.argument}::${left.parserPath}`.localeCompare(
      `${right.entryPath}::${right.argument}::${right.parserPath}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Invoked script discovery
// ---------------------------------------------------------------------------

/** Workspace packages by name, so `pnpm --filter <name> <script>` resolves. */
function workspacePackages() {
  const { packages = [] } = YAML.parse(
    readFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const found = new Map();
  for (const pattern of packages) {
    if (pattern.startsWith("!")) {
      continue;
    }
    assert.ok(
      !/[*?[\]{}]/.test(pattern.replace(/\/\*$/, "")),
      `pnpm-workspace.yaml pattern "${pattern}" is not supported by this test's package discovery; extend workspacePackages().`,
    );
    let directories;
    if (pattern.endsWith("/*")) {
      const parent = path.join(workspaceRoot, pattern.slice(0, -2));
      directories = existsSync(parent)
        ? readdirSync(parent, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(parent, entry.name))
        : [];
    } else {
      directories = [path.join(workspaceRoot, pattern)];
    }
    for (const directory of directories) {
      const manifestPath = path.join(directory, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name) {
        found.set(manifest.name, {
          directory,
          scripts: manifest.scripts ?? {},
        });
      }
    }
  }
  return found;
}

const scriptTokenPattern = /[\w@.+$/{}-]*\.(?:sh|bash|mjs|cjs|js|ts)\b/g;
const pnpmScriptPattern =
  /\bpnpm\s+(?:-r\s+)?--filter[= ]("?)([^\s"]+)\1\s+(?:run\s+)?([\w:.-]+)/g;
const pnpmBuiltInCommands = new Set(["exec"]);
const shellCommentPattern = /^\s*#.*$/gm;

/**
 * Repository files referenced by a command text. Variable prefixes such as
 * `$ROOT_DIR/` are stripped and the remainder resolved against the given base
 * directories, so tokens that exist as files are found wherever the invoking
 * script computes its root from.
 */
function referencedScriptFiles(text, baseDirectories) {
  const files = new Set();
  for (const [token] of text.matchAll(scriptTokenPattern)) {
    const relative = token
      .replace(/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)+/, "")
      .replace(/^\.\//, "");
    if (!relative || /[${}]/.test(relative) || path.isAbsolute(relative)) {
      continue;
    }
    for (const base of baseDirectories) {
      const candidate = path.resolve(base, relative);
      if (
        !candidate.startsWith(`${workspaceRoot}${path.sep}`) ||
        candidate.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        continue;
      }
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        files.add(candidate);
        break;
      }
    }
  }
  return files;
}

/**
 * Every repository script the workflow runs, keyed by workspace-relative path,
 * with the workflow steps that (transitively) invoke it. Follows script file
 * references and `pnpm --filter <package> <script>` invocations up to the
 * configured depth. If another helper is found at the boundary, fail instead
 * of silently leaving that helper (and any summary writer it invokes)
 * unreviewed.
 */
function discoverInvokedScripts({
  steps = allSteps,
  maxDepth = MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH,
} = {}) {
  const packages = workspacePackages();
  const discovered = new Map();
  const visited = new Set();
  const queue = steps
    .filter(({ step }) => typeof step.run === "string")
    .map((origin) => ({
      origin,
      text: origin.step.run,
      baseDirectories: [
        path.resolve(workspaceRoot, origin.step["working-directory"] ?? "."),
      ],
      depth: 0,
    }));

  while (queue.length > 0) {
    const { origin, text, baseDirectories, depth } = queue.shift();
    const commandText = text.replace(shellCommentPattern, "");
    const nested = [];

    for (const file of referencedScriptFiles(commandText, baseDirectories)) {
      const relative = path.relative(workspaceRoot, file);
      // This contract test is itself executed by the hosted release workflow.
      // Its assertions contain summary strings, but it is not a release
      // summary writer and must not recursively expose the scripts it tests.
      if (relative === "scripts/tests/mobile-release-summary-contract.test.mjs") {
        continue;
      }
      if (!discovered.has(relative)) {
        discovered.set(relative, { invokedBy: new Set() });
      }
      discovered.get(relative).invokedBy.add(origin);
      // A script may address siblings relative to itself or relative to the
      // working directory it was launched from (for example a package root).
      nested.push({
        key: relative,
        text: readFileSync(file, "utf8"),
        baseDirectories: [
          path.dirname(file),
          ...baseDirectories,
          workspaceRoot,
        ],
      });
    }

    for (const [, , packageName, scriptName] of commandText.matchAll(
      pnpmScriptPattern,
    )) {
      if (pnpmBuiltInCommands.has(scriptName)) {
        continue;
      }
      const packageEntry = packages.get(packageName);
      assert.ok(
        packageEntry,
        `${origin.label} invokes pnpm package "${packageName}", but no workspace package defines that name.`,
      );
      const command = packageEntry.scripts[scriptName];
      assert.equal(
        typeof command,
        "string",
        `${origin.label} invokes pnpm script "${scriptName}" in "${packageName}", but that package does not define the script.`,
      );
      nested.push({
        key: `${packageName}#${scriptName}`,
        text: command,
        baseDirectories: [packageEntry.directory, workspaceRoot],
      });
    }

    if (depth >= maxDepth) {
      const unvisitedNested = nested.find(
        (item) => !visited.has(`${origin.label}|${item.key}`),
      );
      if (unvisitedNested) {
        throw new Error(
          `${origin.label} exceeds the supported mobile release helper depth of ${maxDepth} while following ${unvisitedNested.key}; extend discovery before adding a deeper helper.`,
        );
      }
    }
    for (const item of nested) {
      const visitKey = `${origin.label}|${item.key}`;
      if (!visited.has(visitKey)) {
        visited.add(visitKey);
        queue.push({ ...item, origin, depth: depth + 1 });
      }
    }
  }
  return discovered;
}

const invokedScripts = discoverInvokedScripts();

function scriptSource(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

const summaryWritingScripts = [...invokedScripts.keys()]
  .filter((relativePath) =>
    scriptSource(relativePath).includes("GITHUB_STEP_SUMMARY"),
  )
  .sort();

function invokingSteps(relativePath) {
  return [...(invokedScripts.get(relativePath)?.invokedBy ?? [])];
}

const summarySteps = [
  ...directSummarySteps,
  ...invokingSteps("scripts/summarize-native-branding.sh").filter(
    (candidate) => !directSummarySteps.includes(candidate),
  ),
];

/** Private variable names a script receives from the workflow, by class. */
function privateNamesFor(relativePath) {
  const classes = new Map();
  for (const { env } of invokingSteps(relativePath)) {
    for (const [name, value] of stringEntries(env)) {
      const source = secretSourceOf(value);
      if (source) {
        classes.set(name, classifySecretSource(source));
      }
    }
  }
  return classes;
}

// ---------------------------------------------------------------------------
// Static workflow contract
// ---------------------------------------------------------------------------

test("release workflow passes secrets to steps only through their environment", () => {
  const problems = [];
  for (const { label, step } of allSteps) {
    if (typeof step.run === "string") {
      if (secretExpressionPattern.test(step.run)) {
        problems.push(
          `${label}: interpolates a secret directly into its run script; map it through env instead.`,
        );
      }
      if (xtracePattern.test(step.run)) {
        problems.push(
          `${label}: enables shell tracing, which echoes expanded secret values into the job log.`,
        );
      }
    }
    if (typeof step.shell === "string" && /\s-[a-zA-Z]*x\b/.test(step.shell)) {
      problems.push(`${label}: uses a tracing shell (${step.shell}).`);
    }
  }
  assertNoProblems(problems, "Mobile release workflow secret handling:");

  assert.ok(
    [...secretBearingEnv.keys()].some((name) => /PASSWORD/.test(name)),
    "expected the workflow to map the smoke-account password into a step environment",
  );
});

test("candidate build IDs use non-secret variables or reusable-workflow inputs", () => {
  assert.equal(
    workflow.on.workflow_call.inputs.native_smoke_ios_build_id.required,
    true,
  );
  assert.equal(
    workflow.on.workflow_call.inputs.native_smoke_android_build_id.required,
    true,
  );
  assert.equal(
    workflow.on.workflow_call.secrets.NATIVE_SMOKE_IOS_BUILD_ID,
    undefined,
  );
  assert.equal(
    workflow.on.workflow_call.secrets.NATIVE_SMOKE_ANDROID_BUILD_ID,
    undefined,
  );
  assert.equal(
    workflow.env.NATIVE_SMOKE_IOS_BUILD_ID,
    "${{ inputs.native_smoke_ios_build_id || vars.NATIVE_SMOKE_IOS_BUILD_ID }}",
  );
  assert.equal(
    workflow.env.NATIVE_SMOKE_ANDROID_BUILD_ID,
    "${{ inputs.native_smoke_android_build_id || vars.NATIVE_SMOKE_ANDROID_BUILD_ID }}",
  );
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /secrets\.NATIVE_SMOKE_(?:IOS|ANDROID)_BUILD_ID/,
  );
});

test("iOS preflight clears stale evidence before it can block evidence uploads", () => {
  const iosJob = workflow.jobs["native-ios"];
  assert.ok(iosJob, "release workflow must define the native-ios job");
  const preflightStep = iosJob.steps.find(
    (step) => step.name === "Check iOS release prerequisites",
  );
  assert.ok(preflightStep, "native-ios must run the iOS prerequisite preflight");
  const cleanupStep = iosJob.steps.find(
    (step) => step.name === "Clear prior iOS evidence from this runner",
  );
  assert.ok(cleanupStep, "native-ios must clear prior iOS evidence");
  assert.match(
    cleanupStep.run,
    /^rm -rf test-results\/native-large-text\/ios$/,
    "stale iOS evidence must be cleared by a fixed cleanup command",
  );

  const preflightIndex = iosJob.steps.indexOf(preflightStep);
  assert.ok(
    iosJob.steps.indexOf(cleanupStep) < preflightIndex,
    "stale iOS evidence must be cleared before the preflight can fail",
  );
  for (const stepName of [
    "Summarize iOS readiness",
    "Upload iOS native smoke artifacts",
    "Summarize iOS native branding",
  ]) {
    const step = iosJob.steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `native-ios must define "${stepName}"`);
    assert.ok(
      iosJob.steps.indexOf(step) > preflightIndex,
      `"${stepName}" must run after the stale-evidence cleanup and preflight`,
    );
  }

  const uploadStep = iosJob.steps.find(
    (step) => step.name === "Upload iOS native smoke artifacts",
  );
  assert.equal(
    uploadStep.if,
    "${{ always() && steps.ios-native-evidence-size.outcome == 'success' }}",
    "the evidence upload must wait for the bounded-size check after the preflight clears stale evidence",
  );
});

test("idle-profile registration check blocks release and reports its result", () => {
  const idleJob = workflow.jobs["idle-profile-registration"];
  assert.ok(idleJob, "release workflow must define the idle-profile job");
  const configStep = idleJob.steps.find(
    (step) => step.name === "Determine idle-profile secret configuration",
  );
  assert.ok(
    configStep,
    "idle-profile job must determine its secret configuration before conditional checks",
  );
  assert.equal(configStep.id, "idle-profile-config");
  assert.equal(configStep.env.E2E_CHAT_URL, "${{ secrets.E2E_CHAT_URL }}");
  assert.equal(configStep.env.E2E_API_URL, "${{ secrets.E2E_API_URL }}");
  assert.equal(
    configStep.env.CLERK_PUBLISHABLE_KEY,
    "${{ secrets.CLERK_PUBLISHABLE_KEY }}",
  );
  assert.equal(configStep.env.CLERK_SECRET_KEY, "${{ secrets.CLERK_SECRET_KEY }}");
  assert.equal(configStep.env.DATABASE_URL, "${{ secrets.DATABASE_URL }}");
  assert.match(
    configStep.run,
    /echo "browser_targets_configured=true" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    configStep.run,
    /echo "release_check_configured=true" >> "\$GITHUB_OUTPUT"/,
  );

  const chatPreflightStep = idleJob.steps.find(
    (step) => step.name === "Verify idle-profile Chat App target",
  );
  const apiPreflightStep = idleJob.steps.find(
    (step) => step.name === "Verify idle-profile API target",
  );
  const preflightRecordStep = idleJob.steps.find(
    (step) => step.name === "Record idle-profile browser target preflight",
  );
  assert.ok(
    chatPreflightStep,
    "idle-profile job must preflight its Chat App target",
  );
  assert.ok(apiPreflightStep, "idle-profile job must preflight its API target");
  assert.ok(
    preflightRecordStep,
    "idle-profile job must record a secret-free preflight reason",
  );
  assert.equal(
    chatPreflightStep.if,
    "${{ steps.idle-profile-config.outputs.browser_targets_configured == 'true' }}",
    "Chat App preflight must run only when browser target configuration is present",
  );
  assert.equal(
    apiPreflightStep.if,
    "${{ steps.idle-profile-config.outputs.browser_targets_configured == 'true' }}",
    "API preflight must run only when browser target configuration is present",
  );
  assert.deepEqual(chatPreflightStep.env, {
    E2E_CHAT_URL: "${{ secrets.E2E_CHAT_URL }}",
  });
  assert.deepEqual(apiPreflightStep.env, {
    E2E_API_URL: "${{ secrets.E2E_API_URL }}",
  });
  assert.match(
    chatPreflightStep.run,
    /--output \/dev\/null[\s\\]*"\$E2E_CHAT_URL"/,
    "preflight must identify and check the configured Chat App target",
  );
  assert.match(
    apiPreflightStep.run,
    /--output \/dev\/null[\s\\]*"\$\{E2E_API_URL%\/\}\/api\/healthz"/,
    "preflight must check the API public health route",
  );
  for (const [label, step] of [
    ["Chat App", chatPreflightStep],
    ["API", apiPreflightStep],
  ]) {
    assert.match(step.run, /--connect-timeout 5/);
    assert.match(step.run, /--max-time 10/);
    assert.match(
      step.run,
      new RegExp(`${label} target is unavailable or unhealthy\\.`),
      "preflight failures must clearly identify the unavailable target",
    );
    assert.doesNotMatch(
      step.run,
      /echo[^\n]*(?:E2E_CHAT_URL|E2E_API_URL)/,
      "preflight diagnostics must not print configured target URLs",
    );
  }
  assert.equal(
    preflightRecordStep.if,
    "${{ always() && steps.idle-profile-config.outputs.browser_targets_configured == 'true' }}",
  );
  assert.deepEqual(preflightRecordStep.env, {
    IDLE_PROFILE_CHAT_PREFLIGHT_RESULT:
      "${{ steps.idle-profile-chat-preflight.outcome }}",
    IDLE_PROFILE_API_PREFLIGHT_RESULT:
      "${{ steps.idle-profile-api-preflight.outcome }}",
  });
  assert.match(
    preflightRecordStep.run,
    /IDLE_PROFILE_CHAT_PREFLIGHT_RESULT" != "success"[\s\S]*failure_reason=chat-app-target-unavailable/,
  );
  assert.match(
    preflightRecordStep.run,
    /IDLE_PROFILE_API_PREFLIGHT_RESULT" != "success"[\s\S]*failure_reason=api-target-unavailable/,
  );

  const runStep = idleJob.steps.find(
    (step) => step.name === "Run idle-profile registration release check",
  );
  assert.ok(runStep, "idle-profile job must run the browser check");
  assert.equal(
    runStep.if,
    "${{ steps.idle-profile-config.outputs.release_check_configured == 'true' }}",
    "idle-profile Playwright check must run only when release-check configuration is present",
  );
  assert.ok(
    idleJob.steps.indexOf(chatPreflightStep) <
      idleJob.steps.indexOf(apiPreflightStep) &&
      idleJob.steps.indexOf(apiPreflightStep) <
        idleJob.steps.indexOf(preflightRecordStep) &&
      idleJob.steps.indexOf(preflightRecordStep) <
        idleJob.steps.indexOf(runStep),
    "both browser targets must be verified before Playwright starts",
  );
  assert.match(
    runStep.run,
    /test:e2e:idle-profile-registration/,
    "idle-profile job must invoke the dedicated Playwright command",
  );
  assert.notEqual(
    runStep["continue-on-error"],
    true,
    "a repeated profile registration must fail the idle-profile job",
  );

  const runStepIndex = idleJob.steps.indexOf(runStep);
  const uploadStep = idleJob.steps.find(
    (step) => step.name === "Upload idle-profile browser failure evidence",
  );
  assert.ok(
    uploadStep,
    "idle-profile job must upload Playwright browser failure evidence",
  );
  assert.ok(
    idleJob.steps.indexOf(uploadStep) > runStepIndex,
    "browser evidence must be uploaded after the Playwright check",
  );
  assert.equal(
    uploadStep.if,
    "${{ always() }}",
    "browser evidence upload must run even when the Playwright check fails",
  );
  assert.equal(uploadStep.uses, pinnedUploadArtifactAction);
  assert.equal(
    uploadStep.with.name,
    "idle-profile-registration-browser-evidence",
  );
  assert.equal(
    uploadStep.with.path,
    "artifacts/api-server/test-results/**",
    "browser evidence upload must target Playwright's configured output directory",
  );
  assert.equal(
    uploadStep.with["if-no-files-found"],
    "warn",
    "missing browser evidence must be visible without hiding the original failure",
  );
  assert.equal(
    uploadStep.with["retention-days"],
    14,
    "browser evidence retention must remain explicit and bounded",
  );
  assert.equal(
    uploadStep.with.overwrite,
    true,
    "rerunning the idle-profile job must replace its prior artifact instead of failing on an immutable-name conflict",
  );
  assert.match(
    playwrightConfig,
    /outputDir:\s*["']\.\.\/test-results["']/,
    "Playwright must write browser evidence to the uploaded directory",
  );
  assert.match(
    playwrightConfig,
    /screenshot:\s*["']only-on-failure["']/,
    "Playwright must retain a screenshot for failed browser checks",
  );
  assert.match(
    playwrightConfig,
    /trace:\s*["']retain-on-failure["']/,
    "Playwright must retain a trace for failed browser checks",
  );

  const summaryStep = idleJob.steps.find(
    (step) => step.name === "Summarize idle-profile registration check",
  );
  assert.ok(summaryStep, "idle-profile job must write a release summary");
  assert.equal(summaryStep.if, "${{ always() }}");
  assert.equal(
    summaryStep.env.IDLE_PROFILE_PREFLIGHT_FAILURE_REASON,
    "${{ steps.idle-profile-preflight.outputs.failure_reason }}",
  );
  assert.match(summaryStep.run, /## Idle profile registration/);
  assert.match(summaryStep.run, /Status: \*\*PASS\*\*/);
  assert.match(summaryStep.run, /Status: \*\*SKIP\*\*/);
  assert.match(summaryStep.run, /Status: \*\*FAIL\*\*/);
  assert.match(
    summaryStep.run,
    /chat-app-target-unavailable\)[\s\S]*Chat App target is unavailable or unhealthy\./,
  );
  assert.match(
    summaryStep.run,
    /api-target-unavailable\)[\s\S]*API target is unavailable or unhealthy\./,
  );

  const gate = workflow.jobs["mobile-release-gate"];
  assert.ok(
    gate.needs.includes("idle-profile-registration"),
    "the final release gate must require the idle-profile job",
  );
  assert.ok(
    gate.needs.includes("native-evidence-summary-regression"),
    "the final release gate must require the hosted native evidence summary regression",
  );
  const blockingStep = gate.steps.find(
    (step) => step.name === "Block release unless both native checks pass",
  );
  assert.equal(
    blockingStep.env.IDLE_PROFILE_RESULT,
    "${{ needs.idle-profile-registration.result }}",
  );
  assert.equal(
    blockingStep.env.SUMMARY_REGRESSION_RESULT,
    "${{ needs.native-evidence-summary-regression.result }}",
    "the final gate must receive the hosted summary regression result",
  );
  assert.match(
    blockingStep.run,
    /\$IDLE_PROFILE_RESULT" != "success"/,
    "the final gate must reject a failed idle-profile job",
  );
  assert.match(
    blockingStep.run,
    /\$SUMMARY_REGRESSION_RESULT" != "success"/,
    "the final gate must reject a failed hosted summary regression",
  );
});

test("native hosted release jobs skip cleanly when release configuration is absent", () => {
  const configJob = workflow.jobs["native-release-configuration"];
  assert.ok(
    configJob,
    "release workflow must define a native release configuration job",
  );
  assert.equal(
    configJob.environment.name,
    "mobile-release",
    "native release configuration must read from the protected release environment",
  );
  assert.equal(
    configJob.outputs?.ios_release_configured,
    "${{ steps.native-release-config.outputs.ios_release_configured }}",
  );
  assert.equal(
    configJob.outputs?.android_release_configured,
    "${{ steps.native-release-config.outputs.android_release_configured }}",
  );

  const configStep = configJob.steps.find(
    (step) => step.name === "Determine native release secret configuration",
  );
  assert.ok(
    configStep,
    "native release configuration job must determine whether hosted release secrets are present",
  );
  assert.equal(configStep.id, "native-release-config");
  assert.equal(configStep.env.EAS_TOKEN, "${{ secrets.EAS_TOKEN }}");
  assert.equal(
    configStep.env.GITHUB_EVENT_NAME,
    "${{ github.event_name }}",
    "native release configuration must distinguish optional manual dispatches from strict release events",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_IOS_APP_ID,
    "${{ secrets.NATIVE_SMOKE_IOS_APP_ID }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_ANDROID_APP_ID,
    "${{ secrets.NATIVE_SMOKE_ANDROID_APP_ID }}",
  );
  assert.equal(configStep.env.NATIVE_SMOKE_EMAIL, "${{ secrets.NATIVE_SMOKE_EMAIL }}");
  assert.equal(
    configStep.env.NATIVE_SMOKE_PASSWORD,
    "${{ secrets.NATIVE_SMOKE_PASSWORD }}",
  );
  assert.equal(
    configStep.env.SENTRY_AUTH_TOKEN,
    "${{ secrets.SENTRY_AUTH_TOKEN }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_IOS_SENTRY_RELEASE,
    "${{ secrets.NATIVE_SMOKE_IOS_SENTRY_RELEASE }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_IOS_SENTRY_DIST,
    "${{ secrets.NATIVE_SMOKE_IOS_SENTRY_DIST }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_ANDROID_SENTRY_RELEASE,
    "${{ secrets.NATIVE_SMOKE_ANDROID_SENTRY_RELEASE }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_ANDROID_SENTRY_DIST,
    "${{ secrets.NATIVE_SMOKE_ANDROID_SENTRY_DIST }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_IOS_BUILD_ID,
    "${{ env.NATIVE_SMOKE_IOS_BUILD_ID }}",
  );
  assert.equal(
    configStep.env.NATIVE_SMOKE_ANDROID_BUILD_ID,
    "${{ env.NATIVE_SMOKE_ANDROID_BUILD_ID }}",
  );
  assert.match(
    configStep.run,
    /echo "ios_release_configured=\$ios_release_configured" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    configStep.run,
    /echo "android_release_configured=\$android_release_configured" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    configStep.run,
    /if \[\[ "\$\{GITHUB_EVENT_NAME:-\}" != "workflow_dispatch" && \( "\$ios_release_configured" != "true" \|\| "\$android_release_configured" != "true" \) \]\]; then/,
    "strict tag and reusable-call runs must fail when native release configuration is incomplete",
  );

  const androidPreflight = workflow.jobs["android-prerequisite-preflight"];
  assert.equal(
    androidPreflight.if,
    "${{ github.event_name != 'pull_request' && needs.native-release-configuration.outputs.android_release_configured == 'true' }}",
    "android runner preflight must skip unless Android release configuration is present",
  );
  assert.ok(
    androidPreflight.needs.includes("native-release-configuration"),
    "android runner preflight must depend on the shared native release configuration job",
  );

  const nativeIos = workflow.jobs["native-ios"];
  assert.equal(
    nativeIos.if,
    "${{ github.event_name != 'pull_request' && needs.native-release-configuration.outputs.ios_release_configured == 'true' }}",
    "native-ios must skip unless iOS release configuration is present",
  );
  assert.ok(
    nativeIos.needs.includes("native-release-configuration"),
    "native-ios must depend on the shared native release configuration job",
  );

  const nativeAndroid = workflow.jobs["native-android"];
  assert.equal(
    nativeAndroid.if,
    "${{ github.event_name != 'pull_request' && needs.native-release-configuration.outputs.android_release_configured == 'true' }}",
    "native-android must skip unless Android release configuration is present",
  );
  assert.ok(
    nativeAndroid.needs.includes("native-release-configuration"),
    "native-android must depend on the shared native release configuration job",
  );
});

test("idle-profile summary reports fixed browser target outages without leaking URLs", () => {
  const idleJob = workflow.jobs["idle-profile-registration"];
  const chatPreflightStep = idleJob.steps.find(
    (step) => step.name === "Verify idle-profile Chat App target",
  );
  const apiPreflightStep = idleJob.steps.find(
    (step) => step.name === "Verify idle-profile API target",
  );
  const preflightRecordStep = idleJob.steps.find(
    (step) => step.name === "Record idle-profile browser target preflight",
  );
  const summaryStep = idleJob.steps.find(
    (step) => step.name === "Summarize idle-profile registration check",
  );
  assert.ok(chatPreflightStep);
  assert.ok(apiPreflightStep);
  assert.ok(preflightRecordStep);
  assert.ok(summaryStep);

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "idle-profile-target-summary-"),
  );
  const binDirectory = path.join(fixtureRoot, "bin");
  mkdirSync(binDirectory);
  writeFileSync(
    path.join(binDirectory, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "exit 22",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const chatUrl = "https://PRIVATE_IDLE_CHAT_TARGET.example/preview";
  const apiUrl = "https://PRIVATE_IDLE_API_TARGET.example";
  const scenarios = [
    {
      name: "Chat App",
      preflightStep: chatPreflightStep,
      preflightEnv: { E2E_CHAT_URL: chatUrl },
      chatOutcome: "failure",
      apiOutcome: "skipped",
      reason: "chat-app-target-unavailable",
      summaryText: "the Chat App target is unavailable or unhealthy.",
    },
    {
      name: "API",
      preflightStep: apiPreflightStep,
      preflightEnv: { E2E_API_URL: apiUrl },
      chatOutcome: "success",
      apiOutcome: "failure",
      reason: "api-target-unavailable",
      summaryText: "the API target is unavailable or unhealthy.",
    },
  ];

  try {
    for (const scenario of scenarios) {
      const preflight = spawnSync(
        bashPath,
        ["-c", scenario.preflightStep.run],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ...scenario.preflightEnv,
            PATH: `${binDirectory}:${process.env.PATH}`,
          },
        },
      );
      const preflightOutput = `${preflight.stdout}${preflight.stderr}`;
      assert.equal(
        preflight.status,
        2,
        `${scenario.name} preflight should fail with the fixed unavailable-target status:\n${preflightOutput}`,
      );
      assert.match(
        preflightOutput,
        new RegExp(`${scenario.name} target is unavailable or unhealthy\\.`),
      );

      const outputPath = path.join(fixtureRoot, `${scenario.name}.output`);
      const recorder = spawnSync(bashPath, ["-c", preflightRecordStep.run], {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          IDLE_PROFILE_CHAT_PREFLIGHT_RESULT: scenario.chatOutcome,
          IDLE_PROFILE_API_PREFLIGHT_RESULT: scenario.apiOutcome,
        },
      });
      const recorderOutput = `${recorder.stdout}${recorder.stderr}`;
      assert.equal(recorder.status, 0, recorderOutput);
      const failureReason = readFileSync(outputPath, "utf8").match(
        /^failure_reason=(.+)$/m,
      )?.[1];
      assert.equal(failureReason, scenario.reason);

      const summaryPath = path.join(fixtureRoot, `${scenario.name}.summary.md`);
      const summary = spawnSync(bashPath, ["-c", summaryStep.run], {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          IDLE_PROFILE_PREFLIGHT_FAILURE_REASON: failureReason,
          IDLE_PROFILE_RESULT: "skipped",
          REVIEWED_REF: "refs/heads/mobile-v0.0.0",
        },
      });
      const summaryOutput = `${summary.stdout}${summary.stderr}`;
      assert.equal(summary.status, 0, summaryOutput);
      const summaryText = readFileSync(summaryPath, "utf8");
      assert.match(summaryText, /- Status: \*\*FAIL\*\*/);
      assert.ok(
        summaryText.includes(scenario.summaryText),
        `${scenario.name} summary should name the failed target:\n${summaryText}`,
      );

      for (const [surface, contents] of [
        ["preflight log", preflightOutput],
        ["preflight recorder log", recorderOutput],
        ["summary log", summaryOutput],
        ["job summary", summaryText],
        ["preflight output", readFileSync(outputPath, "utf8")],
      ]) {
        assert.equal(
          contents.includes(chatUrl) || contents.includes(apiUrl),
          false,
          `${scenario.name} ${surface} must not expose secret-backed target URLs`,
        );
      }
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("failed native evidence checks remain reviewable before blocking release", () => {
  const gate = workflow.jobs["mobile-release-gate"];
  const iosDownload = gate.steps.find(
    (step) => step.id === "download-ios-native-smoke",
  );
  const androidDownload = gate.steps.find(
    (step) => step.id === "download-android-native-smoke",
  );
  const evidenceStep = gate.steps.find(
    (step) => step.name === "Validate native evidence completeness",
  );
  const blockingStep = gate.steps.find(
    (step) => step.name === "Block release unless both native checks pass",
  );

  assert.ok(evidenceStep, "the release gate must validate native evidence");
  assert.equal(
    evidenceStep.if,
    "${{ always() }}",
    "native evidence validation must run so its failure can be summarized",
  );
  assert.equal(
    evidenceStep["continue-on-error"],
    true,
    "native evidence validation must preserve its summary before the blocker runs",
  );
  assert.match(
    evidenceStep.run,
    new RegExp(
      `bash ${untrustedCheckerWrapperScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} bash ${nativeEvidenceCheckerScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    "native evidence validation must use the untrusted checker boundary",
  );
  assert.equal(
    iosDownload?.["continue-on-error"],
    true,
    "iOS artifact download must preserve the final diagnostic when it fails",
  );
  assert.equal(
    androidDownload?.["continue-on-error"],
    true,
    "Android artifact download must preserve the final diagnostic when it fails",
  );
  assert.equal(
    evidenceStep.env.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-ios-native-smoke.outcome == 'success' && 'success' || steps.retry-ios-native-smoke.outcome }}",
    "the evidence checker must receive the iOS initial or retry artifact download result",
  );
  assert.equal(
    evidenceStep.env.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-android-native-smoke.outcome == 'success' && 'success' || steps.retry-android-native-smoke.outcome }}",
    "the evidence checker must receive the Android initial or retry artifact download result",
  );

  assert.ok(
    blockingStep,
    "the release gate must have a separate native evidence blocking step",
  );
  assert.equal(
    blockingStep.if,
    "${{ always() }}",
    "the native evidence blocker must run after a failed validation",
  );
  assert.equal(
    blockingStep.env.EVIDENCE_RESULT,
    "${{ steps.evidence-completeness.outcome }}",
    "the blocker must use the native evidence check outcome",
  );
  assert.match(
    blockingStep.run,
    /\$EVIDENCE_RESULT" != "success"/,
    "a failed native evidence check must block release",
  );

  const summaryRegressionJob =
    workflow.jobs["native-evidence-summary-regression"];
  assert.ok(
    summaryRegressionJob,
    "the workflow must include a hosted native evidence summary regression job",
  );
  const summaryRegressionStep = summaryRegressionJob.steps.find(
    (step) => step.name === "Verify blocked native evidence summary",
  );
  assert.ok(
    summaryRegressionStep,
    "the hosted regression job must verify the blocked native evidence summary",
  );
  assert.match(
    summaryRegressionStep.run,
    /check-native-large-text-evidence\.sh "\$blocked_root"/,
    "the hosted regression must run the checker against a controlled empty evidence root",
  );
  assert.match(
    summaryRegressionStep.run,
    /Missing result directory: \$blocked_root\/ios/,
    "the hosted regression must assert the iOS blocking finding",
  );
  assert.match(
    summaryRegressionStep.run,
    /Missing result directory: \$blocked_root\/android/,
    "the hosted regression must assert the Android blocking finding",
  );
  assert.match(
    summaryRegressionStep.run,
    /cat "\$summary_path" >> "\$GITHUB_STEP_SUMMARY"/,
    "the hosted regression must publish the verified summary to GitHub",
  );

  for (const platform of ["ios", "android"]) {
    const upload = workflow.jobs[`native-${platform}`].steps.find(
      (step) => step.id === `upload-${platform}-native-smoke`,
    );
    assert.equal(
      upload?.if,
      `\${{ always() && steps.${platform}-native-evidence-size.outcome == 'success' }}`,
      `${platform}: evidence upload must survive a failed native check unless the bounded-size check fails`,
    );
    assert.equal(
      upload?.with?.["if-no-files-found"],
      "warn",
      `${platform}: missing evidence must remain visible without hiding the check failure`,
    );
  }
});

test("native evidence downloads retry without exposing evidence contents", () => {
  const downloadPairs = [
    [
      "mobile-release-gate",
      "ios",
      "download-ios-native-smoke",
      "retry-ios-native-smoke",
    ],
    [
      "mobile-release-gate",
      "android",
      "download-android-native-smoke",
      "retry-android-native-smoke",
    ],
    [
      "mobile-publish",
      "ios",
      "download-publish-ios-native-smoke",
      "retry-publish-ios-native-smoke",
    ],
    [
      "mobile-publish",
      "android",
      "download-publish-android-native-smoke",
      "retry-publish-android-native-smoke",
    ],
  ];

  for (const [jobId, platform, downloadId, retryId] of downloadPairs) {
    const steps = workflow.jobs[jobId].steps;
    const download = steps.find((step) => step.id === downloadId);
    const retry = steps.find((step) => step.id === retryId);

    assert.equal(
      download?.uses,
      pinnedDownloadArtifactAction,
      `${jobId}: ${platform} must use the official artifact downloader`,
    );
    assert.equal(
      retry?.uses,
      pinnedDownloadArtifactAction,
      `${jobId}: ${platform} retry must use the official artifact downloader`,
    );
    assert.equal(
      download?.["continue-on-error"],
      true,
      `${jobId}: ${platform} initial download must allow the retry to run`,
    );
    assert.equal(
      retry?.["continue-on-error"],
      true,
      `${jobId}: ${platform} retry must preserve the platform-specific checker summary`,
    );
    assert.equal(
      retry?.if,
      `\${{ always() && steps.${downloadId}.outcome != 'success' && steps.cleanup-${downloadId.replace("download-", "")}.outcome == 'success' }}`,
      `${jobId}: ${platform} retry must run only after cleanup succeeds`,
    );
    assert.deepEqual(
      retry?.with,
      download?.with,
      `${jobId}: ${platform} retry must retrieve the same artifact into the same evidence directory`,
    );
    assert.equal(
      retry?.run,
      undefined,
      `${jobId}: ${platform} retry must not shell-print downloaded evidence`,
    );
  }

  const evidenceStep = workflow.jobs["mobile-release-gate"].steps.find(
    (step) => step.name === "Validate native evidence completeness",
  );
  assert.equal(
    evidenceStep?.env?.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-ios-native-smoke.outcome == 'success' && 'success' || steps.retry-ios-native-smoke.outcome }}",
    "the iOS checker must receive the successful initial or retry outcome",
  );
  assert.equal(
    evidenceStep?.env?.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-android-native-smoke.outcome == 'success' && 'success' || steps.retry-android-native-smoke.outcome }}",
    "the Android checker must receive the successful initial or retry outcome",
  );

  const publishEvidenceStep = workflow.jobs["mobile-publish"].steps.find(
    (step) => step.name === "Require approved iOS and Android evidence",
  );
  assert.equal(
    publishEvidenceStep?.env?.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-publish-ios-native-smoke.outcome == 'success' && 'success' || steps.retry-publish-ios-native-smoke.outcome }}",
    "strict publish validation must receive the successful iOS initial or retry outcome",
  );
  assert.equal(
    publishEvidenceStep?.env?.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-publish-android-native-smoke.outcome == 'success' && 'success' || steps.retry-publish-android-native-smoke.outcome }}",
    "strict publish validation must receive the successful Android initial or retry outcome",
  );
});

test("hosted native evidence regression proves a transient download recovers", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  const recoveryStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Verify temporary native evidence artifact outage recovers on retry",
  );

  assert.ok(
    recoveryStep,
    "the hosted regression job must exercise a temporary artifact outage",
  );
  assert.match(
    recoveryStep.run,
    /download_ios_once[\s\S]*initial_download_status=\$\?[\s\S]*retry_download_status=\$\?/,
    "the hosted regression must execute an initial failed download and a retry",
  );
  assert.match(
    recoveryStep.run,
    /if \[\[ "\$initial_download_status" == "0" \]\]/,
    "the hosted regression must reject an unexpectedly successful first attempt",
  );
  assert.match(
    recoveryStep.run,
    /if \[\[ -e "\$recovery_root\/ios" \]\]/,
    "the hosted regression must prove the failed first attempt leaves no evidence behind",
  );
  assert.match(
    recoveryStep.run,
    /if \[\[ "\$retry_download_status" != "0" \]\]/,
    "the hosted regression must reject a failed retry",
  );
  assert.match(
    recoveryStep.run,
    /download_ios_empty_once[\s\S]*empty_retry_download_status=\$\?/,
    "the hosted regression must exercise a retry that succeeds without extracting a timestamped evidence run",
  );
  assert.match(
    recoveryStep.run,
    /NATIVE_EVIDENCE_REQUIRE_APPROVAL=1[\s\S]*NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=success[\s\S]*empty_retry_summary_path[\s\S]*check-native-large-text-evidence\.sh "\$recovery_root"/,
    "strict publish validation must inspect the extracted evidence after the successful empty retry",
  );
  assert.match(
    recoveryStep.run,
    /simulate_store_submission "\$empty_retry_submission_marker"[\s\S]*if \[\[ -e "\$empty_retry_submission_marker" \]\]/,
    "the successful empty retry must not reach the simulated store submission boundary",
  );
  assert.match(
    recoveryStep.run,
    /NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=success[\s\S]*NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT=success[\s\S]*check-native-large-text-evidence\.sh "\$recovery_root"/,
    "the native checker must receive success only after the retry succeeds",
  );
  assert.match(
    recoveryStep.run,
    /NATIVE_EVIDENCE_REQUIRE_APPROVAL=1[\s\S]*NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=success/,
    "the hosted recovery must exercise strict publish evidence validation after retry",
  );
  assert.match(
    recoveryStep.run,
    /NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=failure[\s\S]*check-native-large-text-evidence\.sh "\$recovery_root"/,
    "the hosted regression must prove a failed retry remains blocking",
  );
  assert.match(
    recoveryStep.run,
    /The native evidence checker passed despite a failed retry\./,
    "the hosted regression must fail if the checker accepts a failed retry",
  );
  assert.match(
    recoveryStep.run,
    /simulate_store_submission "\$recovered_submission_marker"[\s\S]*if \[\[ ! -e "\$recovered_submission_marker" \]\]/,
    "the hosted recovery must prove a successful strict check reaches the submission boundary",
  );
  assert.match(
    recoveryStep.run,
    /simulate_store_submission "\$failed_submission_marker"[\s\S]*if \[\[ -e "\$failed_submission_marker" \]\]/,
    "the hosted recovery must prove a failed retry cannot reach submission",
  );
  assert.match(
    recoveryStep.run,
    /cat "\$pass_summary_path" >> "\$GITHUB_STEP_SUMMARY"/,
    "the hosted regression must publish only the recovered, privacy-safe summary",
  );
  assert.doesNotMatch(
    recoveryStep.run,
    /cat\s+.*(?:candidate-build-id|runner-metadata|pass-fail-record|sentry-source-map)/,
    "the hosted recovery scenario must not print downloaded evidence contents",
  );
});

test("hosted native evidence regression keeps cleanup failures visible", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  assert.deepEqual(
    regressionJob.needs,
    ["mobile-release-node-range"],
    "the hosted cleanup regression must run independently of credential and native-runner availability",
  );
  const prepareStep = regressionJob.steps.find(
    (step) => step.name === "Prepare stale iOS evidence before forced cleanup failure",
  );
  const cleanupStep = regressionJob.steps.find(
    (step) => step.name === "Force iOS retry cleanup failure",
  );
  const retryStep = regressionJob.steps.find(
    (step) => step.name === "Retry iOS native evidence download after failed cleanup",
  );
  const checkerStep = regressionJob.steps.find(
    (step) => step.name === "Run checker after forced retry cleanup failure",
  );
  const verifyStep = regressionJob.steps.find(
    (step) => step.name === "Verify forced retry cleanup failure remains visible and redacted",
  );

  assert.ok(prepareStep, "the hosted cleanup scenario must create stale iOS output");
  assert.ok(cleanupStep, "the hosted cleanup scenario must force cleanup to fail");
  assert.equal(cleanupStep.id, "cleanup-forced-ios");
  assert.equal(cleanupStep["continue-on-error"], true);
  assert.match(
    cleanupStep.run,
    /stale-marker\.txt[\s\S]*Controlled iOS retry cleanup failure injected[\s\S]*false/,
    "the hosted cleanup scenario must fail after confirming stale output exists",
  );

  assert.ok(retryStep, "the hosted cleanup scenario must retain the real retry action");
  assert.equal(retryStep.id, "retry-forced-ios");
  assert.equal(retryStep.uses, pinnedDownloadArtifactAction);
  assert.equal(retryStep["continue-on-error"], true);
  assert.equal(
    retryStep.if,
    "${{ always() && steps.cleanup-forced-ios.outcome == 'success' }}",
    "the retry must be gated on successful cleanup",
  );
  assert.equal(
    retryStep.with.path,
    "${{ runner.temp }}/native-retry-cleanup-failure/ios",
  );

  assert.ok(checkerStep, "the hosted cleanup scenario must run the production checker");
  assert.equal(checkerStep.id, "forced-cleanup-check");
  assert.equal(checkerStep["continue-on-error"], true);
  assert.equal(
    checkerStep.env.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.retry-forced-ios.outcome }}",
  );
  assert.match(
    checkerStep.run,
    /check-native-large-text-evidence\.sh[\s\S]*SUMMARY_PATH%\/summary\.md/,
    "the hosted cleanup scenario must validate the stale extraction root",
  );

  assert.ok(
    verifyStep,
    "the hosted cleanup scenario must verify its fixed redacted summary",
  );
  assert.equal(verifyStep.if, "${{ always() }}");
  assert.equal(
    verifyStep.env.CLEANUP_RESULT,
    "${{ steps.cleanup-forced-ios.outcome }}",
  );
  assert.equal(
    verifyStep.env.RETRY_RESULT,
    "${{ steps.retry-forced-ios.outcome }}",
  );
  assert.match(
    verifyStep.run,
    /"\$RETRY_RESULT" != "skipped"/,
    "the hosted cleanup scenario must require the retry to be skipped",
  );
  assert.match(
    verifyStep.run,
    /NATIVE_IOS_RECOVERY_LINE/,
    "the hosted cleanup scenario must assert the shared iOS recovery line",
  );
  assert.match(
    verifyStep.run,
    /cleanup-failure-evidence-must-not-appear/,
    "the hosted cleanup scenario must reject stale evidence text in the summary",
  );
  assert.match(
    verifyStep.run,
    /cat "\$SUMMARY_PATH" >> "\$GITHUB_STEP_SUMMARY"/,
    "the hosted cleanup scenario must publish the validated summary",
  );
});

test("hosted privacy regression blocks the publish boundary and keeps fixture contents out", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  const privacyCheckStep = regressionJob.steps.find(
    (step) =>
      step.name === "Run controlled failed mobile publish privacy check",
  );
  const summaryStep = regressionJob.steps.find(
    (step) => step.name === "Summarize native evidence privacy regression",
  );
  const submitStep = regressionJob.steps.find(
    (step) => step.name === "Simulate mobile store submission after privacy check",
  );
  const verifyStep = regressionJob.steps.find(
    (step) => step.name === "Verify failed privacy summary blocks simulated store submission",
  );

  assert.ok(
    privacyCheckStep,
    "the hosted regression job must run the real privacy command",
  );
  assert.equal(
    privacyCheckStep.id,
    "native-evidence-privacy",
  );
  assert.equal(
    privacyCheckStep["continue-on-error"],
    true,
    "the hosted regression must retain control after the expected privacy failure",
  );
  assert.equal(
    privacyCheckStep.run,
    "bash scripts/run-untrusted-checker.sh pnpm run test:native-large-text-evidence",
    "the hosted regression must execute the production privacy command",
  );
  assert.equal(
    privacyCheckStep.env.NATIVE_EVIDENCE_PRIVACY_FAILURE_FIXTURE_ROOT,
    "${{ runner.temp }}/native-evidence-privacy-publish",
  );

  assert.ok(summaryStep, "the hosted regression must write the publish summary");
  assert.equal(
    summaryStep.if,
    "${{ always() }}",
    "the failed privacy scenario must still write its reviewer-visible summary",
  );
  assert.equal(
    summaryStep.env.PRIVACY_RESULT,
    "${{ steps.native-evidence-privacy.outcome }}",
    "the publish summary must use the real privacy step outcome",
  );
  const publishSummaryStep = workflow.jobs["mobile-publish"].steps.find(
    (step) => step.name === "Summarize native evidence privacy regression",
  );
  assert.equal(
    summaryStep.run,
    publishSummaryStep?.run,
    "the hosted regression must exercise the same summary branch as mobile-publish",
  );
  assert.match(
    summaryStep.run,
    /echo "- Status: \*\*BLOCKED\*\*"/,
    "the publish summary must record a failed privacy check as BLOCKED",
  );
  assert.match(
    summaryStep.run,
    /privacy checks failed; store submission is blocked\./,
    "the publish summary must explain why submission is blocked",
  );

  assert.ok(
    submitStep,
    "the hosted regression must include a simulated submission step",
  );
  assert.equal(
    submitStep.if,
    "${{ steps.native-evidence-privacy.outcome == 'success' }}",
    "simulated submission must be gated by the real privacy step outcome",
  );
  assert.equal(
    submitStep.env.SUBMISSION_MARKER,
    "${{ runner.temp }}/native-evidence-privacy-publish/store-submission-command-ran",
  );

  assert.ok(
    verifyStep,
    "the hosted regression must verify the failed summary and submission boundary",
  );
  assert.equal(verifyStep.if, "${{ always() }}");
  assert.equal(
    verifyStep.env.PRIVACY_RESULT,
    "${{ steps.native-evidence-privacy.outcome }}",
  );
  assert.match(
    verifyStep.run,
    /if \[\[ "\$PRIVACY_RESULT" != "failure" \]\]/,
    "the hosted regression must require the real privacy step to fail",
  );
  assert.match(
    verifyStep.run,
    /fixture_sentinel[\s\S]*grep -Fq -- "\$fixture_sentinel"/,
    "the hosted privacy scenario must check that fixture contents stay redacted",
  );
  assert.match(
    verifyStep.run,
    /grep -Fq -- "- Status: \*\*BLOCKED\*\*" "\$GITHUB_STEP_SUMMARY"/,
    "the hosted regression must inspect the reviewer-visible BLOCKED summary",
  );
  assert.match(
    verifyStep.run,
    /if \[\[ -e "\$SUBMISSION_MARKER" \]\]/,
    "the hosted regression must prove the simulated submission was skipped",
  );
  assert.doesNotMatch(
    verifyStep.run,
    /cat\s+.*(?:candidate-build-id|runner-metadata|pass-fail-record|sentry-source-map|private-fixture-content)/,
    "the hosted privacy scenario must not print fixture contents",
  );
});

test("successful artifact outcomes cannot approve empty extracted evidence", () => {
  const evidenceRoot = path.join(testRoot, "successful-empty-artifact");
  mkdirSync(path.join(evidenceRoot, "ios"), { recursive: true });
  mkdirSync(path.join(evidenceRoot, "android"), { recursive: true });
  const summaryPath = path.join(
    testRoot,
    "successful-empty-artifact-summary.md",
  );
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_EVIDENCE_REQUIRE_APPROVAL: "1",
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: "success",
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: "success",
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL:
          "https://github.example/example/chat-app/actions/runs/123/artifacts/456",
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL:
          "https://github.example/example/chat-app/actions/runs/123/artifacts/789",
      },
    },
  );

  assert.notEqual(
    result.status,
    0,
    "successful download outcomes must not approve empty extracted evidence",
  );
  const summary = readFileSync(summaryPath, "utf8");
  const iosSection = summary.match(
    /## iOS native large-text evidence[\s\S]*?(?=## Android native large-text evidence)/,
  )?.[0];
  assert.ok(iosSection, "the summary should include the iOS evidence section");
  assert.match(iosSection, /- Status: \*\*FAIL\*\*/);
  assert.match(iosSection, /- Artifact download: \*\*PASS\*\*/);
  assert.match(
    iosSection,
    /download reported success, but no timestamped evidence run directory exists/,
    "the summary must explain that a successful action did not produce evidence",
  );
  assert.match(
    iosSection,
    /- Detailed evidence report: \*\*Unavailable\*\*/,
    "an empty extracted artifact must not receive a report link",
  );
  assert.doesNotMatch(
    summary,
    /github\.example|actions\/runs\/123\/artifacts\/(?:456|789)/,
    "empty artifact report links must not reach the actionable summary",
  );
});

test("hosted native evidence regression exercises real artifact download continuation", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  const uploadStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Store controlled Android artifact for missing iOS scenario",
  );
  const iosDownloadStep = regressionJob.steps.find(
    (step) => step.name === "Download controlled missing iOS artifact",
  );
  const androidDownloadStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Download controlled Android artifact after iOS failure",
  );
  const checkerStep = regressionJob.steps.find(
    (step) => step.name === "Run checker after controlled artifact outage",
  );
  const blockerStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Confirm controlled outage blocks promotion and preserves both sections",
  );

  assert.equal(
    regressionJob.permissions.actions,
    "write",
    "the hosted artifact scenario needs scoped Actions write access for its controlled fixture",
  );
  assert.equal(
    uploadStep?.uses,
    pinnedUploadArtifactAction,
    "the controlled Android fixture must use the pinned upload action",
  );
  assert.equal(
    iosDownloadStep?.uses,
    pinnedDownloadArtifactAction,
    "the missing iOS scenario must use the pinned download action",
  );
  assert.equal(
    androidDownloadStep?.uses,
    pinnedDownloadArtifactAction,
    "the Android continuation must use the pinned download action",
  );
  assert.equal(
    iosDownloadStep?.["continue-on-error"],
    true,
    "the missing iOS download must not stop the following Android download",
  );
  assert.equal(
    androidDownloadStep?.["continue-on-error"],
    true,
    "the controlled Android download must preserve its outcome for the checker",
  );
  assert.equal(
    checkerStep?.env?.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-controlled-ios.outcome }}",
  );
  assert.equal(
    checkerStep?.env?.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-controlled-android.outcome }}",
  );
  assert.equal(
    blockerStep?.env?.IOS_DOWNLOAD_CONCLUSION,
    "${{ steps.download-controlled-ios.conclusion }}",
    "the controlled fixture must model the successful visible conclusion separately from the failed outcome",
  );
  assert.equal(
    checkerStep?.["continue-on-error"],
    true,
    "the checker must publish its blocked summary before the assertion step",
  );
  assert.equal(
    blockerStep?.if,
    "${{ always() }}",
    "the assertion must run after the checker blocks the controlled outage",
  );
  assert.match(
    blockerStep?.run ?? "",
    /Android download did not continue successfully after the iOS failure/,
  );
  assert.match(
    blockerStep?.run ?? "",
    /Rerun the iOS native large-text job/,
  );
  assert.match(
    blockerStep?.run ?? "",
    /Rerun the failed native job or make its artifact available/,
  );
  assert.match(
    blockerStep?.run ?? "",
    /continue-on-error failure[\s\S]*visible conclusion is success/,
    "the controlled fixture must verify the outcome/conclusion distinction",
  );
  const checkerSource = readFileSync(
    path.join(workspaceRoot, nativeEvidenceCheckerScript),
    "utf8",
  );
  assert.match(
    checkerSource,
    /continue-on-error lets the job continue[\s\S]*underlying outcome, which was not success/,
    "the controlled fixture must verify the checker explains why the visible success does not unblock promotion",
  );
});

test("hosted native evidence regression preserves iOS when Android artifact is missing", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  const uploadStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Store controlled iOS artifact for missing Android scenario",
  );
  const iosDownloadStep = regressionJob.steps.find(
    (step) =>
      step.name === "Download controlled iOS artifact before Android failure",
  );
  const androidDownloadStep = regressionJob.steps.find(
    (step) => step.name === "Download controlled missing Android artifact",
  );
  const checkerStep = regressionJob.steps.find(
    (step) => step.name === "Run checker after controlled Android artifact outage",
  );
  const blockerStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Confirm controlled Android outage blocks promotion and preserves both sections",
  );

  assert.equal(
    uploadStep?.uses,
    pinnedUploadArtifactAction,
    "the controlled iOS fixture must use the pinned upload action",
  );
  assert.equal(
    iosDownloadStep?.uses,
    pinnedDownloadArtifactAction,
    "the Android outage scenario must download iOS with the pinned action",
  );
  assert.equal(
    androidDownloadStep?.uses,
    pinnedDownloadArtifactAction,
    "the missing Android scenario must use the pinned download action",
  );
  assert.equal(
    iosDownloadStep?.["continue-on-error"],
    true,
    "the iOS download must preserve its successful result before the Android failure",
  );
  assert.equal(
    androidDownloadStep?.["continue-on-error"],
    true,
    "the missing Android download must preserve its failure for the checker",
  );
  assert.equal(
    checkerStep?.env?.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-controlled-ios-android-outage.outcome }}",
  );
  assert.equal(
    checkerStep?.env?.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
    "${{ steps.download-controlled-android-outage.outcome }}",
  );
  assert.equal(
    checkerStep?.["continue-on-error"],
    true,
    "the Android outage checker must publish its blocked summary before assertions",
  );
  assert.equal(
    blockerStep?.if,
    "${{ always() }}",
    "the Android outage assertion must run after the checker blocks promotion",
  );
  assert.match(
    blockerStep?.run ?? "",
    /iOS artifact download did not continue successfully before the Android failure/,
  );
  assert.match(
    blockerStep?.run ?? "",
    /The controlled Android artifact download unexpectedly succeeded/,
  );
  assert.match(
    blockerStep?.run ?? "",
    /\$NATIVE_ANDROID_RECOVERY_LINE/,
    "the Android outage must retain the shared recovery wording",
  );
  assert.match(
    blockerStep?.run ?? "",
    /iOS completed before the Android failure/,
    "the published summary must retain the independent iOS continuation result",
  );
});

test("hosted release validation exercises nested evidence readers without publishing contents", () => {
  const regressionJob = workflow.jobs["native-evidence-tamper-regression"];
  assert.ok(
    regressionJob,
    "the hosted tamper-regression job must remain available for nested reader validation",
  );

  const readerStep = regressionJob.steps.find(
    (step) =>
      step.name === "Verify nested release evidence readers on hosted runner",
  );
  assert.ok(
    readerStep,
    "the hosted release validation must execute the nested evidence-reader checks",
  );
  assert.equal(
    readerStep.id,
    "nested-release-evidence",
    "the nested reader check outcome must be available to the release summary",
  );
  assert.match(
    readerStep.run,
    /node --test[\s\S]*--test-name-pattern=/,
    "the hosted validation must run the focused contract tests on the release runner",
  );
  assert.match(
    readerStep.run,
    /release evidence discovery catches an un-inventoried nested TypeScript helper reader/,
    "the hosted validation must exercise the nested inventory guard",
  );
  assert.match(
    readerStep.run,
    /nested release evidence reader rejects duplicate fields with fixed redacted diagnostic/,
    "the hosted validation must exercise the fixed duplicate-field diagnostic",
  );

  const summaryStep = regressionJob.steps.find(
    (step) => step.name === "Summarize nested release evidence validation",
  );
  assert.ok(
    summaryStep,
    "the hosted nested reader check must be documented in release validation evidence",
  );
  assert.equal(
    summaryStep.if,
    "${{ always() }}",
    "the nested reader summary must remain visible when its check fails",
  );
  assert.equal(
    summaryStep.env.CHECK_RESULT,
    "${{ steps.nested-release-evidence.outcome }}",
  );
  assert.match(
    summaryStep.run,
    /expected un-inventoried-reader failure diagnostic/,
  );
  assert.match(summaryStep.run, /fixed and redacted/);
  assert.match(
    summaryStep.run,
    /Evidence contents in release validation output: \*\*NOT INCLUDED\*\*/,
  );
});

test("native recovery validation uses the shared contract", () => {
  const regressionJob = workflow.jobs["native-evidence-summary-regression"];
  const failedDownloadStep = regressionJob.steps.find(
    (step) => step.name === "Verify failed platform artifact download summary",
  );
  const bothFailedDownloadStep = regressionJob.steps.find(
    (step) =>
      step.name ===
      "Verify both platform artifact download failures have recovery guidance",
  );

  assert.ok(
    failedDownloadStep,
    "the workflow must keep its single-platform recovery validation",
  );
  assert.ok(
    bothFailedDownloadStep,
    "the workflow must keep its both-platform recovery validation",
  );

  assert.match(
    failedDownloadStep.run,
    /source scripts\/native-release-recovery-contract\.sh/,
    "single-platform recovery validation must source the shared contract",
  );
  assert.match(
    failedDownloadStep.run,
    /\$NATIVE_IOS_RECOVERY_LINE/,
    "single-platform recovery validation must use the shared iOS line",
  );
  assert.match(
    bothFailedDownloadStep.run,
    /source scripts\/native-release-recovery-contract\.sh/,
    "both-platform recovery validation must source the shared contract",
  );
  assert.match(
    bothFailedDownloadStep.run,
    /\$NATIVE_IOS_RECOVERY_LINE[\s\S]*\$NATIVE_ANDROID_RECOVERY_LINE/,
    "both-platform recovery validation must use both shared lines",
  );
});

test("failed native evidence checks remain reviewable before blocking release", () => {
  const gate = workflow.jobs["mobile-release-gate"];
  const evidenceStep = gate.steps.find(
    (step) => step.name === "Validate native evidence completeness",
  );
  const blockingStep = gate.steps.find(
    (step) => step.name === "Block release unless both native checks pass",
  );

  assert.ok(evidenceStep, "the release gate must validate native evidence");
  assert.equal(
    evidenceStep.if,
    "${{ always() }}",
    "native evidence validation must run so its failure can be summarized",
  );
  assert.equal(
    evidenceStep["continue-on-error"],
    true,
    "native evidence validation must preserve its summary before the blocker runs",
  );
  assert.match(
    evidenceStep.run,
    new RegExp(
      `bash ${untrustedCheckerWrapperScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} bash ${nativeEvidenceCheckerScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    "native evidence validation must use the untrusted checker boundary",
  );

  assert.ok(
    blockingStep,
    "the release gate must have a separate native evidence blocking step",
  );
  assert.equal(
    blockingStep.if,
    "${{ always() }}",
    "the native evidence blocker must run after a failed validation",
  );
  assert.equal(
    blockingStep.env.EVIDENCE_RESULT,
    "${{ steps.evidence-completeness.outcome }}",
    "the blocker must use the native evidence check outcome",
  );
  assert.match(
    blockingStep.run,
    /\$EVIDENCE_RESULT" != "success"/,
    "a failed native evidence check must block release",
  );

  for (const platform of ["ios", "android"]) {
    const upload = workflow.jobs[`native-${platform}`].steps.find(
      (step) => step.id === `upload-${platform}-native-smoke`,
    );
    assert.equal(
      upload?.if,
      `\${{ always() && steps.${platform}-native-evidence-size.outcome == 'success' }}`,
      `${platform}: evidence upload must survive a failed native check unless the bounded-size check fails`,
    );
    assert.equal(
      upload?.with?.["if-no-files-found"],
      "warn",
      `${platform}: missing evidence must remain visible without hiding the check failure`,
    );
  }
});

test("publish requires candidate-bound approvals from the current run attempt", () => {
  const attemptSuffix = "${{ github.run_id }}-${{ github.run_attempt }}";
  for (const [jobId, platform] of [
    ["native-ios", "ios"],
    ["native-android", "android"],
  ]) {
    assert.ok(
      workflow.jobs[jobId].env.NATIVE_SMOKE_RESULTS_DIR.endsWith(
        `/${attemptSuffix}`,
      ),
      `${jobId} evidence directory must be unique to the GitHub run attempt`,
    );
    const upload = workflow.jobs[jobId].steps.find(
      (step) => step[`uses`] === pinnedUploadArtifactAction,
    );
    assert.equal(
      upload?.with?.name,
      `native-large-text-${platform}`,
      `${jobId} must use a stable artifact name so partial reruns retain the other platform`,
    );
    assert.equal(
      upload?.with?.overwrite,
      true,
      `${jobId} must replace its own prior-attempt artifact after a rerun`,
    );
    assert.equal(
      workflow.jobs[jobId].outputs?.native_evidence_artifact_url,
      `\${{ steps.upload-${platform}-native-smoke.outputs.artifact-url }}`,
      `${jobId} must expose the uploaded evidence artifact URL`,
    );
    assert.ok(
      workflow.jobs[jobId].steps.some(
        (step) =>
          step.run === `rm -rf test-results/native-large-text/${platform}`,
      ),
      `${jobId} must clear stale self-hosted-runner evidence before collection`,
    );
  }

  assert.equal(
    workflow.jobs["mobile-release-gate"].outputs
      ?.ios_native_evidence_artifact_url,
    "${{ needs.native-ios.outputs.native_evidence_artifact_url }}",
    "the final release gate must carry the iOS evidence artifact URL forward",
  );
  assert.equal(
    workflow.jobs["mobile-release-gate"].outputs
      ?.android_native_evidence_artifact_url,
    "${{ needs.native-android.outputs.native_evidence_artifact_url }}",
    "the final release gate must carry the Android evidence artifact URL forward",
  );
  const evidenceStep = workflow.jobs["mobile-release-gate"].steps.find(
    (step) => step.name === "Validate native evidence completeness",
  );
  assert.equal(
    evidenceStep?.env?.NATIVE_IOS_EVIDENCE_ARTIFACT_URL,
    "${{ needs.native-ios.outputs.native_evidence_artifact_url }}",
    "the evidence checker must receive the uploaded iOS artifact URL",
  );
  assert.equal(
    evidenceStep?.env?.NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL,
    "${{ needs.native-android.outputs.native_evidence_artifact_url }}",
    "the evidence checker must receive the uploaded Android artifact URL",
  );

  for (const jobId of ["mobile-release-gate", "mobile-publish"]) {
    const downloads = workflow.jobs[jobId].steps.filter(
      (step) =>
        step[`uses`] === pinnedDownloadArtifactAction &&
        step.id?.startsWith("download"),
    );
    assert.deepEqual(
      downloads.map((step) => step.with.name).sort(),
      ["native-large-text-android", "native-large-text-ios"],
      `${jobId} must support mixed-attempt artifacts after a partial rerun`,
    );
  }

  const publishSteps = workflow.jobs["mobile-publish"].steps;
  const privacyIndex = publishSteps.findIndex(
    (step) =>
      step.name ===
      "Run native large-text evidence privacy and submission-boundary regression",
  );
  const privacyStep = publishSteps[privacyIndex];
  const privacySummaryStep = publishSteps.find(
    (step) => step.name === "Summarize native evidence privacy regression",
  );
  assert.ok(privacyIndex >= 0, "publish job must run the privacy check");
  assert.equal(
    privacyStep.id,
    "native-evidence-privacy",
    "publish privacy step must expose its outcome for downstream guards",
  );
  assert.notEqual(
    privacyStep["continue-on-error"],
    true,
    "a failed publish privacy check must fail the job instead of continuing",
  );
  assert.equal(
    privacyStep.if,
    undefined,
    "the publish privacy check must use normal success gating",
  );
  assert.ok(
    privacySummaryStep,
    "publish job must retain its reviewer-visible privacy summary",
  );
  assert.equal(
    privacySummaryStep.if,
    "${{ always() }}",
    "the publish privacy summary must survive a failed privacy check",
  );
  const privacySummaryIndex = publishSteps.indexOf(privacySummaryStep);
  assert.ok(
    privacySummaryIndex > privacyIndex,
    "the publish privacy summary must follow the privacy check",
  );
  assert.equal(
    privacySummaryStep.env.PRIVACY_RESULT,
    "${{ steps.native-evidence-privacy.outcome }}",
    "the publish privacy summary must use the real privacy step outcome",
  );
  assert.equal(
    workflow.jobs["mobile-publish"].environment.name,
    "mobile-store-submission",
    "store submission must use its dedicated protected environment",
  );
  assert.match(
    workflow.jobs["mobile-publish"].if,
    /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.publish == true/,
    "only an explicit manual dispatch may enter the store submission job",
  );
  assert.doesNotMatch(
    workflow.jobs["mobile-publish"].if,
    /workflow_call|push/,
    "automated callers and tags must not enter the store submission job",
  );
  const approvalIndex = publishSteps.findIndex(
    (step) => step.name === "Attach candidate-bound human approvals",
  );
  const strictIndex = publishSteps.findIndex(
    (step) => step.name === "Require approved iOS and Android evidence",
  );
  const submitIndex = publishSteps.findIndex(
    (step) => step.name === "Submit the tested iOS and Android candidates",
  );
  for (const stepName of [
    "Attach candidate-bound human approvals",
    "Require approved iOS and Android evidence",
    "Verify publishing inputs",
    "Submit the tested iOS and Android candidates",
  ]) {
    const step = publishSteps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `publish job must define "${stepName}"`);
    assert.equal(
      step.if,
      "${{ steps.native-evidence-privacy.outcome == 'success' }}",
      `${stepName} must be unreachable after a failed privacy check`,
    );
    assert.ok(
      publishSteps.indexOf(step) > privacySummaryIndex,
      `${stepName} must follow the privacy summary`,
    );
  }
  assert.ok(approvalIndex >= 0, "publish job must attach human approvals");
  assert.ok(
    strictIndex > approvalIndex,
    "strict check must follow approval intake",
  );
  assert.ok(
    submitIndex > strictIndex,
    "strict check must run before store submission",
  );
  assert.equal(
    publishSteps[strictIndex].env.NATIVE_EVIDENCE_REQUIRE_APPROVAL,
    "1",
    "publish evidence validation must enable strict approval mode",
  );
  assert.equal(
    publishSteps[strictIndex].env.NATIVE_IOS_EVIDENCE_ARTIFACT_URL,
    "${{ needs.mobile-release-gate.outputs.ios_native_evidence_artifact_url }}",
    "publish evidence validation must retain the iOS artifact link",
  );
  assert.equal(
    publishSteps[strictIndex].env.NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL,
    "${{ needs.mobile-release-gate.outputs.android_native_evidence_artifact_url }}",
    "publish evidence validation must retain the Android artifact link",
  );
  const approvalScript = publishSteps[approvalIndex].run;
  const candidateFileValidationIndex = approvalScript.indexOf(
    "line_count == 1 && non_empty_count == 1",
  );
  const candidateFileReadIndex = approvalScript.indexOf(
    'tested_build_id="$(head -n 1 "$run_dir/candidate-build-id.txt"',
  );
  assert.ok(
    candidateFileValidationIndex >= 0,
    "publish approval intake must reject multi-line and empty candidate build ID files itself",
  );
  assert.ok(
    candidateFileReadIndex > candidateFileValidationIndex,
    "publish approval intake must validate the complete candidate build ID file before selecting its first line",
  );
  assert.match(
    approvalScript,
    /downloaded candidate build ID must contain exactly one non-empty identifier line/,
    "publish approval intake must explain the candidate file shape without exposing its contents",
  );
  assert.doesNotMatch(
    approvalScript,
    /(?:echo|printf)[^\n]*(?:tested_build_id|candidate-build-id\.txt)/,
    "publish approval diagnostics must not print candidate identifier contents or the downloaded file",
  );
  assert.ok(
    approvalScript.includes(
      'if [[ "$approved_build_id" != "$tested_build_id" ]]',
    ),
    "publish approval intake must match approval and evidence candidate IDs",
  );
  assert.ok(
    approvalScript.includes(
      'if [[ "$submit_build_id" != "$tested_build_id" ]]',
    ),
    "publish approval intake must bind submitted build IDs to validated evidence",
  );
  assert.equal(
    publishSteps[approvalIndex].env.IOS_SUBMIT_BUILD_ID,
    "${{ env.NATIVE_SMOKE_IOS_BUILD_ID }}",
  );
  assert.equal(
    publishSteps[approvalIndex].env.ANDROID_SUBMIT_BUILD_ID,
    "${{ env.NATIVE_SMOKE_ANDROID_BUILD_ID }}",
  );
  assert.equal(
    workflow.permissions.actions,
    "read",
    "pull-request jobs must retain read-only Actions access",
  );
  for (const jobId of [
    "native-ios",
    "native-android",
    "idle-profile-registration",
    "native-evidence-summary-regression",
  ]) {
    assert.equal(
      workflow.jobs[jobId].permissions.actions,
      "write",
      `${jobId} needs scoped Actions write access to replace its release artifact`,
    );
  }
  assert.equal(
    publishSteps[approvalIndex].env.GH_TOKEN,
    "${{ github.token }}",
    "approval verification must use the scoped workflow token",
  );
  assert.match(
    publishSteps[approvalIndex].run,
    /actions\/runs\/\$GH_RUN_ID\/approvals/,
    "review records must query the current run's approval history",
  );
  assert.match(
    publishSteps[approvalIndex].run,
    /review\.state === "approved"[\s\S]*environment\.name === "mobile-store-submission"/,
    "review records must use the actual approver of the protected submission environment",
  );
  assert.doesNotMatch(
    JSON.stringify(publishSteps[approvalIndex]),
    /github\.actor/,
    "the workflow dispatcher must not be recorded as the environment approver",
  );
  assert.match(
    publishSteps[approvalIndex].run,
    /date -u \+%Y-%m-%dT%H:%M:%SZ/,
    "review records must derive their timestamp at the protected publish gate",
  );
  assert.ok(
    !Object.keys(workflow.on.workflow_dispatch.inputs).some((name) =>
      /reviewer|reviewed_at/.test(name),
    ),
    "manual callers must not be able to supply reviewer identity or review time",
  );
});

function summaryEnvExpressionProblem(expression, { jobId, job }) {
  const trimmed = expression.trim();
  if (
    /^steps\.[\w-]+\.(outcome|conclusion)$/.test(trimmed) ||
    /^steps\.[\w-]+\.(outcome|conclusion)\s*==\s*'[^']*'\s*&&\s*'[^']*'\s*\|\|\s*steps\.[\w-]+\.(outcome|conclusion)$/.test(
      trimmed,
    ) ||
    /^needs\.[\w-]+\.result$/.test(trimmed) ||
    /^needs\.[\w-]+\.outputs\.[\w-]+$/.test(trimmed) ||
    trimmed === "job.status" ||
    /^(?:github\.(?!token\b)[\w.-]+|runner\.\w+|inputs\.[\w-]+)$/.test(
      trimmed,
    ) ||
    /^inputs\.[\w-]+\s*\|\|\s*vars\.[\w-]+$/.test(trimmed)
  ) {
    return null;
  }

  const envReference = trimmed.match(/^env\.(\w+)$/);
  if (envReference) {
    return secretBearingEnv.has(envReference[1])
      ? `env.${envReference[1]} is mapped from a secret`
      : null;
  }

  const outputReference = trimmed.match(/^steps\.([\w-]+)\.outputs\.[\w-]+$/);
  if (outputReference) {
    const producer = (job.steps ?? []).find(
      (candidate) => candidate.id === outputReference[1],
    );
    if (!producer) {
      return `step "${outputReference[1]}" does not exist in job ${jobId}`;
    }
    const producerInputs = [
      ...stringEntries(workflow.env),
      ...stringEntries(job.env),
      ...stringEntries(producer.env),
      ...stringEntries(producer.with),
    ];
    if (
      producerInputs.some(([, value]) => secretExpressionPattern.test(value))
    ) {
      return `step "${outputReference[1]}" receives secrets, so its outputs cannot feed a summary`;
    }
    return null;
  }

  return `expression "${trimmed}" is not on the summary allowlist (step outcomes, needs results, non-secret env, github/runner/inputs context, outputs of secret-free steps)`;
}

test("release summary steps cannot see or interpolate secret values", () => {
  assert.ok(
    summarySteps.length > 0,
    "expected at least one workflow step to write GITHUB_STEP_SUMMARY",
  );

  const problems = [];
  for (const summaryStep of summarySteps) {
    const { label, step, env } = summaryStep;

    for (const [name, value] of stringEntries(env)) {
      if (secretBearingEnv.has(name)) {
        problems.push(
          `${label}: ${name} is mapped from a secret elsewhere in the workflow and must not be visible to a summary step.`,
        );
      }
      if (secretExpressionPattern.test(value)) {
        problems.push(`${label}: ${name} maps a secret into a summary step.`);
      }
      for (const [, expression] of value.matchAll(actionExpressionPattern)) {
        const problem = summaryEnvExpressionProblem(expression, summaryStep);
        if (problem) {
          problems.push(`${label}: ${name}: ${problem}.`);
        }
      }
    }

    const script = step.run;
    if (/\$\{\{/.test(script)) {
      problems.push(
        `${label}: uses a workflow expression inside the summary script; resolve values through env instead.`,
      );
    }
    for (const name of secretBearingEnv.keys()) {
      if (variableReferencePattern(name).test(script)) {
        problems.push(
          `${label}: expands ${name}, which is mapped from a secret, inside the summary script.`,
        );
      }
    }
    if (indirectExpansionPattern.test(script)) {
      problems.push(
        `${label}: uses indirect expansion, which can read arbitrary variables into the summary.`,
      );
    }
    if (environmentDumpPatterns.some((pattern) => pattern.test(script))) {
      problems.push(
        `${label}: dumps the process environment, which would include any secret in scope.`,
      );
    }
  }
  assertNoProblems(problems, "Release summary steps must stay secret-free:");
});

test("every summary-writing script the release workflow invokes has a contract", () => {
  assert.ok(
    invokingSteps(iosGateScript).length > 0,
    `expected the workflow to invoke ${iosGateScript} (directly or through a package script); discovery may be broken`,
  );
  assert.ok(
    invokingSteps(androidPreflightScript).length > 0,
    `expected the workflow to invoke ${androidPreflightScript}; discovery may be broken`,
  );

  const inventory = Object.keys(scriptContracts).sort();
  assert.deepEqual(
    summaryWritingScripts,
    inventory,
    [
      "The set of workflow-invoked scripts that write GITHUB_STEP_SUMMARY must match the scriptContracts inventory.",
      `  discovered: ${JSON.stringify(summaryWritingScripts)}`,
      `  inventory:  ${JSON.stringify(inventory)}`,
      "Add a contract (static rules plus a sentinel run) for a new summary writer, or remove an entry that no longer writes a summary.",
    ].join("\n"),
  );
});

test("deeply nested release helpers fail before bypassing the summary inventory", () => {
  const fixtureDirectory = mkdtempSync(
    path.join(workspaceRoot, ".mobile-release-summary-contract-"),
  );
  const helperNames = [
    "entry.sh",
    ...Array.from(
      { length: MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH + 1 },
      (_, index) => `helper-${index + 1}.sh`,
    ),
  ];
  const helperPaths = helperNames.map((name) =>
    path.join(fixtureDirectory, name),
  );

  helperPaths.forEach((helperPath, index) => {
    const nextName = helperNames[index + 1];
    writeFileSync(
      helperPath,
      [
        "#!/usr/bin/env bash",
        ...(nextName
          ? [`bash ${nextName}`]
          : ['printf "hidden summary writer\\n" >> "$GITHUB_STEP_SUMMARY"']),
      ].join("\n"),
    );
  });

  try {
    assert.throws(
      () =>
        discoverInvokedScripts({
          steps: [
            {
              label: "deep helper fixture",
              step: {
                run: `bash ${path.relative(workspaceRoot, helperPaths[0])}`,
                "working-directory": ".",
              },
            },
          ],
          maxDepth: MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH,
        }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(
            `supported mobile release helper depth of ${MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH}`,
          ),
        );
        assert.match(
          error.message,
          new RegExp(
            `helper-${MAX_INVOKED_SCRIPT_DISCOVERY_DEPTH}\\.sh`,
          ),
        );
        return true;
      },
      "a summary writer beyond the supported helper depth must not disappear from discovery",
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

function releaseEvidenceReaderInventory(discovered) {
  return [
    ...new Set(
      discovered.map(
        ({ entryPath, argument }) => `${entryPath}::${argument}`,
      ),
    ),
  ].sort();
}

function assertReleaseEvidenceReaderInventory(discovered) {
  const inventory = Object.keys(releaseEvidenceReaderContracts)
    .flatMap((relativePath) =>
      releaseEvidenceReaderContractsFor(relativePath).map(
        (contract) => `${relativePath}::${contract.argument}`,
      ),
    )
    .sort();
  const discoveredInventory = releaseEvidenceReaderInventory(discovered);

  assert.deepEqual(
    discoveredInventory,
    inventory,
    [
      "The release evidence JSON reader inventory must cover every JSON.parse call in release-check scripts.",
      `  discovered: ${JSON.stringify(discoveredInventory)}`,
      `  inventory:  ${JSON.stringify(inventory)}`,
      "Add the reader to the inventory and make it use findDuplicateJsonObjectKeys before JSON.parse.",
    ].join("\n"),
  );
}

function assertReleaseEvidenceReader({ entryPath, parserPath, argument }) {
  const contract = releaseEvidenceReaderContractsFor(entryPath).find(
    (candidate) => candidate.argument === argument,
  );
  assert.ok(
    contract,
    `The release evidence JSON reader ${entryPath} (JSON.parse(${argument}) in ${parserPath}) must have an inventory contract.`,
  );
  const source = scriptSource(parserPath);
  const scannerCall = contract.scannerCall.replace(
    /\([^)]*\)$/,
    `(${argument})`,
  );
  const scannerIndex = source.indexOf(scannerCall);
  const parseIndex = source.search(
    new RegExp(`JSON\\.parse\\(\\s*${argument}\\s*\\)`),
  );

  assert.ok(
    scannerIndex >= 0,
    `${contract.name} must use the shared duplicate-key scanner.`,
  );
  assert.ok(
    parseIndex >= 0,
    `${contract.name} must parse its evidence source with JSON.parse.`,
  );
  assert.ok(
    scannerIndex < parseIndex,
    `${contract.name} must scan for duplicate fields before JSON.parse applies last-value-wins semantics.`,
  );
  assert.match(
    source,
    contract.duplicateFailure,
    `${contract.name} must keep duplicate-field failures fixed and redacted.`,
  );
}

test("every release JSON evidence reader rejects duplicate fields with fixed diagnostics", () => {
  const discovered = discoverReleaseEvidenceJsonParses();
  assertReleaseEvidenceReaderInventory(discovered);

  for (const { entryPath, parserPath, argument } of discovered) {
    assertReleaseEvidenceReader({ entryPath, parserPath, argument });
  }
});

test(
  "release evidence discovery catches an un-inventoried nested TypeScript helper reader",
  () => {
    const fixtureDirectory = mkdtempSync(
      path.join(workspaceRoot, ".mobile-release-summary-contract-"),
    );
    const entryPath = path.join(fixtureDirectory, "release-check.mjs");
    const helperPath = path.join(fixtureDirectory, "nested", "reader.ts");
    mkdirSync(path.dirname(helperPath), { recursive: true });
    writeFileSync(
      entryPath,
      'import { readEvidence } from "./nested/reader";\nreadEvidence();\n',
    );
    writeFileSync(
      helperPath,
      [
        "export function readEvidence() {",
        "  return JSON.parse(evidence);",
        "}",
      ].join("\n"),
    );

    try {
      const discovered = discoverReleaseEvidenceJsonParses([entryPath]);
      assert.deepEqual(releaseEvidenceReaderInventory(discovered), [
        `${path.relative(workspaceRoot, entryPath)}::evidence`,
      ]);
      assert.throws(
        () => assertReleaseEvidenceReaderInventory(discovered),
        /The release evidence JSON reader inventory must cover every JSON\.parse call in release-check scripts\./,
      );
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  },
);

test("release evidence discovery follows helpers dynamically imported by shell checks", () => {
  const fixtureDirectory = mkdtempSync(
    path.join(workspaceRoot, ".mobile-release-summary-contract-"),
  );
  const entryPath = path.join(fixtureDirectory, "release-check.sh");
  const helperPath = path.join(fixtureDirectory, "nested", "reader.mjs");
  const relativeEntryPath = path.relative(workspaceRoot, entryPath);
  mkdirSync(path.dirname(helperPath), { recursive: true });
  writeFileSync(
    entryPath,
    [
      "#!/usr/bin/env bash",
      'ROOT_DIR="$(pwd)"',
      'node --input-type=module - "$ROOT_DIR/PLACEHOLDER/nested/reader.mjs" <<\'NODE\'',
      'import { pathToFileURL } from "node:url";',
      "const [, , readerPath] = process.argv;",
      "const { readEvidence } = await import(pathToFileURL(readerPath).href);",
      "readEvidence(rawEvidence);",
      "NODE",
    ].join("\n").replace("PLACEHOLDER", path.basename(fixtureDirectory)),
  );
  writeFileSync(
    helperPath,
    [
      "export function readEvidence(rawEvidence) {",
      "  return JSON.parse(rawEvidence);",
      "}",
    ].join("\n"),
  );

  releaseEvidenceReaderContracts[relativeEntryPath] = {
    name: "shell delegated evidence",
    argument: "rawEvidence",
    scannerCall: "findDuplicateJsonObjectKeys(rawEvidence)",
    duplicateFailure: /delegated evidence contains duplicate fields/,
  };

  try {
    const discovered = discoverReleaseEvidenceJsonParses([entryPath]);
    assert.deepEqual(discovered, [
      {
        entryPath: relativeEntryPath,
        parserPath: path.relative(workspaceRoot, helperPath),
        argument: "rawEvidence",
      },
    ]);
    assert.throws(
      () => assertReleaseEvidenceReader({ ...discovered[0] }),
      /shell delegated evidence must use the shared duplicate-key scanner\./,
    );
  } finally {
    delete releaseEvidenceReaderContracts[relativeEntryPath];
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test(
  "nested release evidence reader rejects duplicate fields with fixed redacted diagnostic",
  () => {
    const fixtureDirectory = mkdtempSync(
      path.join(workspaceRoot, ".mobile-release-summary-contract-"),
    );
    const entryPath = path.join(fixtureDirectory, "release-check.mjs");
    const helperPath = path.join(fixtureDirectory, "nested", "reader.mjs");
    const duplicateMarker =
      "NESTED_RELEASE_EVIDENCE_PRIVATE_CONTENT_MUST_NOT_ESCAPE";
    try {
      mkdirSync(path.dirname(helperPath), { recursive: true });
      writeFileSync(
        entryPath,
        'import { readEvidence } from "./nested/reader.mjs";\nreadEvidence();\n',
      );
      writeFileSync(
        helperPath,
        [
          `import { findDuplicateJsonObjectKeys } from ${JSON.stringify(
            pathToFileURL(
              path.join(
                workspaceRoot,
                "scripts/find-duplicate-json-object-keys.mjs",
              ),
            ).href,
          )};`,
          "const rawEvidence = " +
            JSON.stringify(
              `{"status":"PASS","status":"${duplicateMarker}"}`,
            ) +
            ";",
          "export function readEvidence() {",
          "  if (findDuplicateJsonObjectKeys(rawEvidence).length > 0) {",
          '    throw new Error("Nested release evidence contains duplicate fields.");',
          "  }",
          "  return JSON.parse(rawEvidence);",
          "}",
          "readEvidence();",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [entryPath], {
        cwd: workspaceRoot,
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(
        result.status,
        0,
        "the nested evidence reader must reject duplicate fields",
      );
      assert.match(
        output,
        /Nested release evidence contains duplicate fields\./,
      );
      assert.doesNotMatch(
        output,
        new RegExp(duplicateMarker),
        "the nested reader diagnostic must not expose evidence contents",
      );
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  },
);

test("the native shell evidence check keeps its dynamic helper closure", () => {
  const entryPath = path.join(
    workspaceRoot,
    "scripts/check-native-large-text-evidence.sh",
  );
  const closure = discoverLocalModuleClosure(entryPath);

  for (const helperPath of [
    "scripts/find-duplicate-json-object-keys.mjs",
    "scripts/read-bounded-text.mjs",
    "scripts/validate-junit-xml.mjs",
  ]) {
    assert.ok(
      closure.has(path.join(workspaceRoot, helperPath)),
      `${entryPath} must keep its local ${helperPath} helper visible to the release contract`,
    );
  }
});

test("non-evidence JSON parsing embedded in shell remains excluded", () => {
  const fixtureDirectory = mkdtempSync(
    path.join(workspaceRoot, ".mobile-release-summary-contract-"),
  );
  const entryPath = path.join(fixtureDirectory, "utility.sh");
  writeFileSync(
    entryPath,
    [
      "#!/usr/bin/env bash",
      "node --input-type=module - <<'NODE'",
      'const [, , packageJson] = process.argv;',
      "JSON.parse(packageJson);",
      "NODE",
    ].join("\n"),
  );

  try {
    assert.deepEqual(discoverReleaseEvidenceJsonParses([entryPath]), []);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("Android preview evidence keeps its pull-request validation and privacy contract", () => {
  const androidJob = workflow.jobs["android-preview-evidence"];
  assert.ok(androidJob, "the release workflow must define the Android preview job");
  assert.equal(
    androidJob.if,
    "${{ github.event_name == 'pull_request' }}",
    "Android preview evidence must be isolated to pull requests",
  );
  assert.deepEqual(
    androidJob.steps.find(
      (step) => step.name === "Validate changed Android preview records",
    )?.env,
    {
      ANDROID_PREVIEW_BASE_SHA:
        "${{ github.event.pull_request.base.sha }}",
      ANDROID_PREVIEW_HEAD_SHA:
        "${{ github.event.pull_request.head.sha }}",
      REVIEWED_REF: "${{ github.ref }}",
    },
    "the Android preview job must compare the pull request base and head",
  );

  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "pull_request"),
    "the release workflow must support pull_request",
  );
  assert.equal(
    workflow.on.pull_request?.paths,
    undefined,
    "the Android preview evidence check must not use a pull_request path filter",
  );
  assert.equal(
    workflow.on.pull_request?.["paths-ignore"],
    undefined,
    "the Android preview evidence check must not use pull_request paths-ignore rules",
  );

  const validationStep = androidJob.steps.find(
    (step) => step.name === "Validate changed Android preview records",
  );
  assert.ok(validationStep, "the Android preview job must validate changed records");
  assert.match(
    validationStep.run,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*echo "## Reviewed release revision"[\s\S]*Checked ref: `%s`[\s\S]*Resolved commit SHA: `%s`/,
    "the Android preview summary must record the checked revision",
  );
  assert.ok(
    validationStep.run.indexOf('echo "## Reviewed release revision"') <
      validationStep.run.indexOf('>> "$GITHUB_STEP_SUMMARY"'),
    "Android revision metadata must precede every preview summary branch",
  );
  assert.doesNotMatch(
    validationStep.run,
    /secrets\.|E2E_CHAT_URL|E2E_API_URL|CLERK_SECRET_KEY|DATABASE_URL/,
    "Android preview revision metadata must not expose secrets or private URLs",
  );
  const ocrStep = androidJob.steps.find(
    (step) => step.name === "Install screenshot OCR runtime",
  );
  assert.ok(
    ocrStep,
    "the Android preview job must provision the screenshot OCR runtime",
  );
  assert.match(
    ocrStep.run,
    /sudo apt-get update[\s\S]*sudo apt-get install[\s\S]*tesseract-ocr[\s\S]*tesseract-ocr-eng/,
    "the Android preview job must install Tesseract and its English language data",
  );
  assert.match(
    ocrStep.run,
    /command -v tesseract[\s\S]*tesseract --list-langs[\s\S]*grep -Fxq ["']eng["']/,
    "the Android preview job must verify that Tesseract and English OCR data are available",
  );
  assert.ok(
    androidJob.steps.indexOf(ocrStep) < androidJob.steps.indexOf(validationStep),
    "the Android preview job must provision OCR before invoking the evidence checker",
  );
  assert.match(
    validationStep.run,
    /git diff[\s\S]*--find-renames[\s\S]*\$\{ANDROID_PREVIEW_BASE_SHA\}\.\.\.\$\{ANDROID_PREVIEW_HEAD_SHA\}[\s\S]*artifacts\/chat-app\/test-results\/encrypted-room-recovery\/android\/\*\*\/validation-record\.md/,
    "the job must select changed Android validation records from the pull request diff",
  );
  assert.match(
    validationStep.run,
    /artifacts\/chat-app\/test-results\/encrypted-room-recovery\/android\/\*\*\/android-preview-preflight\.json/,
    "the job must select changed Android preflight sidecars from the pull request diff",
  );
  assert.match(
    validationStep.run,
    /changed_preflight_paths[\s\S]*record_path="\$\{changed_path%\/android-preview-preflight\.json\}\/validation-record\.md"/,
    "a changed Android preflight sidecar must map to its sibling Markdown record",
  );
  assert.match(
    validationStep.run,
    /LC_ALL=C sort -u/,
    "Android preview records must use a locale-independent path order",
  );
  assert.match(
    validationStep.run,
    /checker_args=\("\$record_path"\)[\s\S]*checker_args\+=\("\$preflight_path"\)[\s\S]*validate:android-preview-evidence -- "\$\{checker_args\[@\]\}"/,
    "changed Android preflight sidecars must be passed explicitly to the checker",
  );
  assert.match(
    validationStep.run,
    /validator_directory="artifacts\/chat-app\/scripts"[\s\S]*validator_file="validate-preview-startup\.mjs"[\s\S]*validator_path="\$\{validator_directory\}\/\$\{validator_file\}"[\s\S]*if \[\[ ! -f "\$validator_path" \]\][\s\S]*validator_failure_reason=/,
    "the Android job must check its delegated validator dependency before checking changed records",
  );
  assert.match(
    validationStep.run,
    /elif \[\[ -n "\$validator_failure_reason" \]\][\s\S]*reasons="\$validator_failure_reason"[\s\S]*else[\s\S]*validation_output="\$\(/,
    "a missing delegated validator must produce a fixed reason without invoking the record checker",
  );
  assert.match(
    validationStep.run,
    /record_revision="\$GITHUB_SHA"[\s\S]*if \[\[ ! -f "\$record_path" \]\][\s\S]*record_revision="\$ANDROID_PREVIEW_BASE_SHA"[\s\S]*record_url="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/blob\/\$\{record_revision\}\/\$\{record_path\}"/,
    "each changed record must receive a GitHub link, using the base revision when the record was deleted",
  );
  assert.ok(
    validationStep.run.includes(
      `reasons="$(printf '%s\\n' "$validation_output" | sed -n '/^- /p')"`
    ),
    "only fixed checker reason lines may enter the summary",
  );
  assert.doesNotMatch(
    validationStep.run,
    /cat\s+"\$record_path"|validation_output.*GITHUB_STEP_SUMMARY/,
    "the job must not print Android record evidence into the summary",
  );

  const hostedRenameJob = workflow.jobs["android-preview-rename-regression"];
  assert.ok(
    hostedRenameJob,
    "the release workflow must define the hosted Android rename regression",
  );
  assert.equal(
    hostedRenameJob.if,
    "${{ github.event_name == 'pull_request' }}",
    "the hosted Android rename regression must run on pull requests",
  );
  const hostedCheckout = hostedRenameJob.steps.find(
    (step) => step.name === "Check out reviewed pull request",
  );
  assert.ok(hostedCheckout, "the hosted Android regression must check out the PR");
  assert.equal(hostedCheckout.with?.["fetch-depth"], 0);
  assert.equal(hostedCheckout.with?.["persist-credentials"], false);
  const hostedValidation = hostedRenameJob.steps.find(
    (step) => step.name === "Run renamed Android preview evidence regression",
  );
  assert.ok(hostedValidation, "the hosted Android regression must run its fixture");
  assert.deepEqual(hostedValidation.env, {
    ANDROID_PREVIEW_BASE_SHA:
      "${{ github.event.pull_request.base.sha }}",
    ANDROID_PREVIEW_HEAD_SHA:
      "${{ github.event.pull_request.head.sha }}",
    REVIEWED_REF: "${{ github.ref }}",
  });
  assert.match(
    hostedValidation.run,
    /git cat-file -e "\$\{ANDROID_PREVIEW_BASE_SHA\}\^\{commit\}"[\s\S]*git cat-file -e "\$\{ANDROID_PREVIEW_HEAD_SHA\}\^\{commit\}"/,
    "the hosted regression must verify both pull-request commits are available",
  );
  assert.match(
    hostedValidation.run,
    /git diff[\s\S]*--name-only[\s\S]*--find-renames[\s\S]*"\$\{base_sha\}\.\.\.\$\{head_sha\}"[\s\S]*validation-record\.md[\s\S]*android-preview-preflight\.json/,
    "the hosted regression must exercise Git rename detection over base and head",
  );
  assert.match(
    hostedValidation.run,
    /validate:android-preview-evidence --[\s\S]*"\$record_path" "\$preflight_path"/,
    "the hosted regression must pass each destination record and matching sidecar to the checker",
  );
  assert.match(
    hostedValidation.run,
    /Changed records checked: \*\*\$\{#changed_records\[@\]\}\*\*/,
    "the hosted regression must write the reviewer-visible summary",
  );
  assert.match(
    hostedValidation.run,
    /record_count=.*grep -Fc[\s\S]*link_count=.*grep -Fc[\s\S]*grep -Fxc/,
    "the hosted regression must enforce one section, one link, and one checker input per destination",
  );
  assert.match(
    hostedValidation.run,
    /Hosted renamed Android preview evidence regression passed\./,
    "the hosted regression must report a fixed success diagnostic",
  );

  const blockedRecord = `# Android SDK 57 preview validation record

**Result: BLOCKED — no physical Android handoff was available**

## Metadata

| Field | Result |
| --- | --- |
| Device model | **BLOCKED** — no physical Android device was available |
| Android version | **BLOCKED** — no physical Android device was available |
| Expo Go version | **BLOCKED** — no Expo Go session was available |

## Boundary results

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | public manifest HTTP 200 (128 bytes) |
| Local handoff probe (manifest and bundle) | NOT_RUN | Local manifest/bundle probe not run — no successful probe result was recorded |
| Expo Go launch on physical Android | **BLOCKED** | No physical phone was available. |
| Server-side native request evidence | **BLOCKED** | No native Android request was available. |
`;
  const blockedPreflight = `{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical Android phone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
`;
  const mismatchedPreflight = blockedPreflight.replace(
    '"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"',
    '"status":"FAIL","evidence":"Public manifest probe failed — no successful probe result was recorded"',
  );
  const changedBlockedPreflight = blockedPreflight.replace(
    "public manifest HTTP 200 (128 bytes)",
    "public manifest HTTP 200 (256 bytes)",
  );
  const changedBlockedPreflight512 = blockedPreflight.replace(
    "public manifest HTTP 200 (128 bytes)",
    "public manifest HTTP 200 (512 bytes)",
  );

  function runAndroidPreviewJob(name, recordText, options = {}) {
    const {
      sidecarOnly = false,
      changedPreflight = blockedPreflight,
      missingValidator = false,
      renameRecord = false,
      diffOrder = "default",
    } = options;
    const fixtureRoot = path.join(testRoot, `android-preview-${name}`);
    const recordDefinitions = Array.isArray(recordText)
      ? recordText
      : [{ timestamp: "20260915T120000Z", text: recordText }];
    const defaultBaseTimestamp = "20260915T120000Z";
    const recordPaths = recordDefinitions.map(({ timestamp }) =>
      path.join(
        fixtureRoot,
        `artifacts/chat-app/test-results/encrypted-room-recovery/android/${timestamp}/validation-record.md`,
      ),
    );
    const preflightPaths = recordDefinitions.map(({ timestamp }) =>
      path.join(
        fixtureRoot,
        `artifacts/chat-app/test-results/encrypted-room-recovery/android/${timestamp}/android-preview-preflight.json`,
      ),
    );
    const baseRecordPaths = recordDefinitions.map(
      ({ timestamp, baseTimestamp = defaultBaseTimestamp }) =>
        path.join(
          fixtureRoot,
          `artifacts/chat-app/test-results/encrypted-room-recovery/android/${renameRecord ? baseTimestamp : timestamp}/validation-record.md`,
        ),
    );
    const basePreflightPaths = recordDefinitions.map(
      ({ timestamp, baseTimestamp = defaultBaseTimestamp }) =>
        path.join(
          fixtureRoot,
          `artifacts/chat-app/test-results/encrypted-room-recovery/android/${renameRecord ? baseTimestamp : timestamp}/android-preview-preflight.json`,
        ),
    );
    const recordModes = recordDefinitions.map((definition) => {
      if (definition.mode !== undefined) {
        return definition.mode;
      }
      if (sidecarOnly) {
        return "sidecar-only";
      }
      return definition.preflight === undefined ? "record-only" : "paired";
    });
    const recordPath = recordPaths[0];
    const preflightPath = preflightPaths[0];
    const summaryPath = path.join(fixtureRoot, "summary.md");
    const runnerPath = path.join(fixtureRoot, "run-job.sh");
    const binDirectory = path.join(fixtureRoot, "bin");
    for (const record of [...recordPaths, ...baseRecordPaths]) {
      mkdirSync(path.dirname(record), { recursive: true });
    }
    mkdirSync(binDirectory, { recursive: true });
    const validatorPath = path.join(
      fixtureRoot,
      "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    );
    if (!missingValidator) {
      mkdirSync(path.dirname(validatorPath), { recursive: true });
      writeFileSync(validatorPath, "// contract fixture\n");
    }
    for (const [
      index,
      { text, baseText, preflight, deleted },
    ] of recordDefinitions.entries()) {
      if (deleted) {
        writeFileSync(baseRecordPaths[index], baseText ?? text);
        if (preflight !== undefined) {
          writeFileSync(basePreflightPaths[index], blockedPreflight);
        }
      } else if (
        recordModes[index] === "sidecar-only" ||
        recordModes[index] === "paired"
      ) {
        writeFileSync(baseRecordPaths[index], baseText ?? text);
        writeFileSync(basePreflightPaths[index], blockedPreflight);
      }
    }

    const git = (args) => {
      const result = spawnSync(gitPath, args, {
        cwd: fixtureRoot,
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
      );
    };
    git(["init", "--quiet"]);
    git(["config", "user.email", "contract-test@example.invalid"]);
    git(["config", "user.name", "Contract Test"]);
    writeFileSync(path.join(fixtureRoot, "README.md"), "base\n");
    git([
      "add",
      "README.md",
      ...recordDefinitions.flatMap(({ preflight, deleted }, index) => {
        if (deleted) {
          return [
            baseRecordPaths[index],
            ...(preflight === undefined ? [] : [basePreflightPaths[index]]),
          ];
        }
        return recordModes[index] === "sidecar-only" ||
          recordModes[index] === "paired"
          ? [baseRecordPaths[index], basePreflightPaths[index]]
          : [];
      }),
      ...(!missingValidator ? [validatorPath] : []),
    ]);
    git(["commit", "--quiet", "-m", "base"]);
    const baseSha = spawnSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).stdout.trim();
    const changedPaths = [];
    if (renameRecord) {
      for (const [index, recordMode] of recordModes.entries()) {
        if (recordMode !== "sidecar-only" && recordMode !== "paired") {
          continue;
        }
        mkdirSync(path.dirname(recordPaths[index]), { recursive: true });
        renameSync(baseRecordPaths[index], recordPaths[index]);
        renameSync(basePreflightPaths[index], preflightPaths[index]);
      }
    }
    for (const [
      index,
      { text, preflight, deleted },
    ] of recordDefinitions.entries()) {
      if (deleted) {
        rmSync(baseRecordPaths[index]);
        changedPaths.push(baseRecordPaths[index]);
        if (preflight !== undefined) {
          rmSync(basePreflightPaths[index]);
          changedPaths.push(basePreflightPaths[index]);
        }
        continue;
      }
      if (
        recordModes[index] === "record-only" ||
        recordModes[index] === "paired"
      ) {
        writeFileSync(recordPaths[index], text);
        changedPaths.push(recordPaths[index]);
      }
      if (
        recordModes[index] === "sidecar-only" ||
        recordModes[index] === "paired"
      ) {
        writeFileSync(
          preflightPaths[index],
          recordModes[index] === "sidecar-only"
            ? changedPreflight
            : preflight,
        );
        changedPaths.push(preflightPaths[index]);
      }
    }
    git(renameRecord ? ["add", "-A"] : ["add", ...changedPaths]);
    git(["commit", "--quiet", "-m", "android preview record"]);
    const headSha = spawnSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).stdout.trim();

    const pnpmCalledPath = path.join(fixtureRoot, "pnpm-called");
    const checkerArgsLogPath = path.join(fixtureRoot, "checker-args.log");
    if (diffOrder === "reverse") {
      writeStub(
        binDirectory,
        "git",
        `set -euo pipefail
if [[ "\${1:-}" == "diff" ]]; then
  diff_output="$(${shellQuote(gitPath)} "$@")"
  mapfile -t diff_paths <<< "$diff_output"
  for ((index=\${#diff_paths[@]} - 1; index >= 0; index--)); do
    [[ -n "\${diff_paths[index]}" ]] || continue
    printf '%s\n' "\${diff_paths[index]}"
  done
else
  exec ${shellQuote(gitPath)} "$@"
fi`,
      );
    }
    writeStub(
      binDirectory,
      "pnpm",
      `set -euo pipefail\ntouch ${shellQuote(pnpmCalledPath)}\nchecker_args=()\nfound_separator=0\nfor arg in "$@"; do\n  if [[ "$arg" == "--" ]]; then\n    found_separator=1\n    continue\n  fi\n  if ((found_separator)); then\n    checker_args+=("$arg")\n  fi\ndone\nprintf '%s\\t%s\\n' "\${checker_args[0]}" "\${checker_args[1]:-}" >> "$ANDROID_PREVIEW_ARGS_LOG"\nexec bash "$ANDROID_PREVIEW_CHECKER" "\${checker_args[@]}"`,
    );
    mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, untrustedCheckerWrapperScript),
      readFileSync(path.join(workspaceRoot, untrustedCheckerWrapperScript)),
    );
    chmodSync(path.join(fixtureRoot, untrustedCheckerWrapperScript), 0o755);
    writeFileSync(
      path.join(fixtureRoot, workflowOutputSafetyScript),
      readFileSync(path.join(workspaceRoot, workflowOutputSafetyScript)),
    );
    chmodSync(path.join(fixtureRoot, workflowOutputSafetyScript), 0o755);
    writeFileSync(runnerPath, `#!${bashPath}\n${validationStep.run}\n`);
    chmodSync(runnerPath, 0o755);

    const result = spawnSync(bashPath, [runnerPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
        ANDROID_PREVIEW_BASE_SHA: baseSha,
        ANDROID_PREVIEW_HEAD_SHA: headSha,
        ANDROID_PREVIEW_CHECKER: path.join(
          workspaceRoot,
          "scripts/check-android-preview-evidence.sh",
        ),
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: "example/chat-app",
        REVIEWED_REF: "refs/heads/mobile-v0.0.0",
        GITHUB_SHA: headSha,
        GITHUB_STEP_SUMMARY: summaryPath,
        ANDROID_PREVIEW_ARGS_LOG: checkerArgsLogPath,
      },
    });
    return {
      result,
      baseSha,
      headSha,
      recordPath: path.relative(fixtureRoot, recordPath),
      recordPaths: recordPaths.map((record) => path.relative(fixtureRoot, record)),
      baseRecordPath: path.relative(fixtureRoot, baseRecordPaths[0]),
      baseRecordPaths: baseRecordPaths.map((record) =>
        path.relative(fixtureRoot, record),
      ),
      preflightPath: path.relative(fixtureRoot, preflightPath),
      preflightPaths: preflightPaths.map((preflight) =>
        path.relative(fixtureRoot, preflight),
      ),
      checkerArgs: existsSync(checkerArgsLogPath)
        ? readFileSync(checkerArgsLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t"))
        : [],
      summary: readFileSync(summaryPath, "utf8"),
      checkerInvoked: existsSync(pnpmCalledPath),
    };
  }

  const blocked = runAndroidPreviewJob("blocked", blockedRecord);
  assert.equal(
    blocked.result.status,
    0,
    `a valid BLOCKED Android preview record must keep the job successful:\n${blocked.result.stdout}\n${blocked.result.stderr}`,
  );
  assert.match(blocked.summary, /- Record result: \*\*BLOCKED \(valid\)\*\*/);
  assert.match(
    blocked.summary,
    new RegExp(
      `\\[${blocked.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${blocked.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "the successful BLOCKED summary must link the checked record",
  );
  assert.doesNotMatch(
    blocked.summary,
    /Workspace curl returned HTTP 200|No physical phone was available/,
    "the successful BLOCKED summary must not copy evidence text",
  );

  const renamed = runAndroidPreviewJob(
    "renamed",
    [
      {
        timestamp: "20260915T121500Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "No physical phone was available.",
          "PRIVATE_RENAMED_ANDROID_EVIDENCE no physical phone was available.",
        ),
        preflight: blockedPreflight,
      },
    ],
    { renameRecord: true },
  );
  assert.equal(
    renamed.result.status,
    0,
    "a valid renamed Android preview record and sidecar must keep the job successful",
  );
  assert.match(
    renamed.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a renamed Android preview pair must count as one changed record",
  );
  assert.deepEqual(
    renamed.checkerArgs,
    [[renamed.recordPath, renamed.preflightPath]],
    "a renamed Android record must be checked with its renamed sibling sidecar",
  );
  const renamedRecordLink = new RegExp(
    `\\[${renamed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${renamed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    "g",
  );
  assert.equal(
    renamed.summary.match(renamedRecordLink)?.length ?? 0,
    1,
    "a renamed Android record must have one stable destination link",
  );
  assert.doesNotMatch(
    renamed.summary,
    new RegExp(
      renamed.baseRecordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "a renamed Android record must not leave its old path in the summary",
  );
  assert.doesNotMatch(
    renamed.summary,
    /PRIVATE_RENAMED_ANDROID_EVIDENCE|Workspace curl returned HTTP 200|No physical phone was available/,
    "a renamed Android summary must not expose evidence text",
  );

  const renamedMalformed = runAndroidPreviewJob(
    "renamed-malformed",
    [
      {
        timestamp: "20260915T121500Z",
        baseText: blockedRecord,
        text: blockedRecord
          .replace("**Result: BLOCKED", "**Result: PASS")
          .replace(
            "No physical phone was available.",
            "PRIVATE_RENAMED_ANDROID_EVIDENCE no physical phone was available.",
          ),
        preflight: blockedPreflight,
      },
    ],
    { renameRecord: true },
  );
  const renamedMalformedFailure = [
    renamedMalformed.result.stdout,
    renamedMalformed.result.stderr,
  ].join("\n");
  assert.notEqual(
    renamedMalformed.result.status,
    0,
    "a malformed renamed Android preview record must fail the job",
  );
  assert.match(
    renamedMalformed.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a malformed renamed Android record must count as one changed record",
  );
  assert.equal(
    renamedMalformed.checkerArgs.length,
    1,
    "a malformed renamed Android record must produce one checker invocation",
  );
  assert.deepEqual(
    renamedMalformed.checkerArgs,
    [[renamedMalformed.recordPath, renamedMalformed.preflightPath]],
    "a malformed renamed Android record must be checked with its renamed sibling sidecar",
  );
  const renamedMalformedRecordLink = new RegExp(
    `\\[${renamedMalformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${renamedMalformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    "g",
  );
  assert.equal(
    renamedMalformed.summary.match(renamedMalformedRecordLink)?.length ?? 0,
    1,
    "a malformed renamed Android record must have one destination link",
  );
  assert.doesNotMatch(
    renamedMalformed.summary,
    new RegExp(
      renamedMalformed.baseRecordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "a malformed renamed Android record must not leave its old path in the summary",
  );
  assert.match(
    renamedMalformed.summary,
    /Validation: \*\*FAIL\*\*[\s\S]*PASS records must include a real Device model value\./,
    "a malformed renamed Android record must report the fixed checker reason",
  );
  assert.match(
    renamedMalformedFailure,
    /PASS records must include a real Device model value\./,
    "the surfaced malformed renamed Android checker failure must use the fixed reason",
  );
  assert.doesNotMatch(
    `${renamedMalformed.summary}\n${renamedMalformedFailure}`,
    /PRIVATE_RENAMED_ANDROID_EVIDENCE|Workspace curl returned HTTP 200|No physical phone was available/,
    "a malformed renamed Android record must not expose evidence text",
  );

  const multipleRenamed = runAndroidPreviewJob(
    "multiple-renamed",
    [
      {
        baseTimestamp: "20260915T120000Z",
        timestamp: "20260915T121500Z",
        baseText: blockedRecord,
        text: blockedRecord
          .replace(
            "public manifest HTTP 200 (128 bytes)",
            "public manifest HTTP 200 (256 bytes)",
          )
          .replace(
            "No physical phone was available.",
            "PRIVATE_RENAMED_ANDROID_EVIDENCE_A no physical phone was available.",
          ),
        preflight: changedBlockedPreflight,
      },
      {
        baseTimestamp: "20260915T120500Z",
        timestamp: "20260915T122000Z",
        baseText: blockedRecord,
        text: blockedRecord
          .replace(
            "public manifest HTTP 200 (128 bytes)",
            "public manifest HTTP 200 (512 bytes)",
          )
          .replace(
            "No physical phone was available.",
            "PRIVATE_RENAMED_ANDROID_EVIDENCE_B no physical phone was available.",
          ),
        preflight: changedBlockedPreflight512,
      },
      {
        baseTimestamp: "20260915T121000Z",
        timestamp: "20260915T122500Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "No physical phone was available.",
          "PRIVATE_RENAMED_ANDROID_EVIDENCE_C no physical phone was available.",
        ),
        preflight: blockedPreflight,
      },
    ],
    { renameRecord: true },
  );
  assert.equal(
    multipleRenamed.result.status,
    0,
    "multiple renamed Android preview pairs must keep the job successful",
  );
  assert.match(
    multipleRenamed.summary,
    /- Changed records checked: \*\*3\*\*/,
    "the summary must count each renamed Android destination exactly once",
  );
  assert.deepEqual(
    multipleRenamed.checkerArgs,
    multipleRenamed.recordPaths.map((recordPath, index) => [
      recordPath,
      multipleRenamed.preflightPaths[index],
    ]),
    "the checker must receive each renamed record with its matching sidecar exactly once",
  );
  for (const [index, recordPath] of multipleRenamed.recordPaths.entries()) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      multipleRenamed.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `each renamed Android destination must have one stable link: ${recordPath}`,
    );
    assert.equal(
      multipleRenamed.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `each renamed Android destination must have one validation section: ${recordPath}`,
    );
    assert.match(
      multipleRenamed.summary,
      new RegExp(
        `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?- Validation: \\*\\*PASS\\*\\*`,
      ),
      `each renamed Android destination must report its validation result: ${recordPath}`,
    );
    assert.doesNotMatch(
      multipleRenamed.summary,
      new RegExp(
        multipleRenamed.baseRecordPaths[index].replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
      ),
      `the renamed Android summary must not retain the old path for ${recordPath}`,
    );
  }
  assert.doesNotMatch(
    multipleRenamed.summary,
    /PRIVATE_RENAMED_ANDROID_EVIDENCE_[ABC]|Workspace curl returned HTTP 200|No physical phone was available/,
    "the multi-record renamed Android summary must not expose evidence text",
  );

  const incompletePass = runAndroidPreviewJob(
    "incomplete-pass",
    blockedRecord
      .replace("**Result: BLOCKED", "**Result: PASS")
      .replace(
        "No physical phone was available.",
        "PRIVATE_EVIDENCE_MARKER no physical phone was available.",
      ),
  );
  assert.notEqual(
    incompletePass.result.status,
    0,
    "an incomplete PASS Android preview record must fail the job",
  );
  assert.match(
    incompletePass.summary,
    /#### Missing-boundary reason[\s\S]*PASS records must include a real Device model value\./,
    "the failed summary must report a sanitized checker reason",
  );
  assert.match(
    incompletePass.summary,
    new RegExp(
      `\\[${incompletePass.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${incompletePass.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "the failed summary must still link the checked record",
  );
  assert.doesNotMatch(
    incompletePass.summary,
    /PRIVATE_EVIDENCE_MARKER|Workspace curl returned HTTP 200|No physical phone was available/,
    "the failed summary must not expose record evidence text",
  );

  const mixedRecordDefinitions = [
    {
      timestamp: "20260915T120000Z",
      baseText: blockedRecord,
      text: blockedRecord.replace(
        "public manifest HTTP 200 (128 bytes)",
        "public manifest HTTP 200 (256 bytes)",
      ),
      preflight: changedBlockedPreflight,
    },
    {
      timestamp: "20260915T121000Z",
      baseText: blockedRecord,
      text: blockedRecord,
      preflight: blockedPreflight,
      deleted: true,
    },
    {
      timestamp: "20260915T121500Z",
      text: blockedRecord.replace(
        "No physical phone was available.",
        "PRIVATE_MULTI_RECORD_EVIDENCE no physical phone was available.",
      ),
      preflight: mismatchedPreflight,
    },
  ];
  const multiRecord = runAndroidPreviewJob(
    "multi-record",
    mixedRecordDefinitions,
  );
  const multiRecordReversed = runAndroidPreviewJob(
    "multi-record-reversed",
    mixedRecordDefinitions,
    { diffOrder: "reverse" },
  );
  assert.notEqual(
    multiRecord.result.status,
    0,
    "a mismatched or deleted Android preview record must fail only its record",
  );
  assert.match(
    multiRecord.summary,
    /- Changed records checked: \*\*3\*\*/,
    "the summary must count every changed Android preview record",
  );
  assert.deepEqual(
    multiRecord.checkerArgs,
    [
      [multiRecord.recordPaths[0], multiRecord.preflightPaths[0]],
      [multiRecord.recordPaths[2], multiRecord.preflightPaths[2]],
    ],
    "each present changed Android preflight sidecar must be passed to the checker even after a deleted record",
  );
  assert.equal(
    multiRecordReversed.result.status,
    multiRecord.result.status,
    "reordering the pull request diff must preserve the overall blocking status",
  );
  assert.deepEqual(
    multiRecordReversed.checkerArgs,
    [
      [multiRecordReversed.recordPaths[0], multiRecordReversed.preflightPaths[0]],
      [multiRecordReversed.recordPaths[2], multiRecordReversed.preflightPaths[2]],
    ],
    "reordering the pull request diff must not change which present records are checked",
  );
  for (const recordPath of multiRecord.recordPaths) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordIndex = multiRecord.recordPaths.indexOf(recordPath);
    const expectedRevision =
      recordIndex === 1 ? multiRecord.baseSha : multiRecord.headSha;
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${expectedRevision}/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${expectedRevision}/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      multiRecord.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `the multi-record summary must include exactly one stable link for ${recordPath}`,
    );
    assert.equal(
      multiRecord.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `the multi-record summary must include exactly one validation section for ${recordPath}`,
    );
    assert.match(
      multiRecord.summary,
      new RegExp(
        `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${expectedRevision}/${escapedPath}\\)[\\s\\S]*?- Validation: \\*\\*(?:PASS|FAIL)\\*\\*`,
      ),
      `the multi-record summary must include the validation result for ${recordPath}`,
    );
  }
  for (const [recordIndex, recordPath] of multiRecordReversed.recordPaths.entries()) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expectedRevision =
      recordIndex === 1
        ? multiRecordReversed.baseSha
        : multiRecordReversed.headSha;
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${expectedRevision}/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${expectedRevision}/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      multiRecordReversed.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `the reversed mixed summary must include exactly one stable link for ${recordPath}`,
    );
    assert.equal(
      multiRecordReversed.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `the reversed mixed summary must include exactly one validation section for ${recordPath}`,
    );
  }
  const reversedSummarySectionPaths = [
    ...multiRecordReversed.summary.matchAll(/^### \[([^\]]+)\]\(/gm),
  ].map(([, recordPath]) => recordPath);
  assert.deepEqual(
    reversedSummarySectionPaths,
    [...multiRecordReversed.recordPaths].sort(),
    "the reversed mixed Android summary must emit every section in deterministic path order",
  );
  assert.equal(
    multiRecordReversed.summary.match(/- Validation: \*\*PASS\*\*/g)?.length ?? 0,
    1,
    "the reversed mixed summary must preserve the valid record result",
  );
  assert.equal(
    multiRecordReversed.summary.match(/- Validation: \*\*FAIL\*\*/g)?.length ?? 0,
    2,
    "the reversed mixed summary must preserve the deleted and invalid failures",
  );
  assert.match(
    multiRecordReversed.summary,
    /- Record result: \*\*BLOCKED \(valid\)\*\*/,
    "the reversed mixed summary must preserve the valid BLOCKED record result",
  );
  assert.match(
    multiRecordReversed.summary,
    /changed Android preview validation record is missing from the checked-out commit\./,
    "the reversed mixed summary must preserve the deleted-record result",
  );
  assert.match(
    multiRecordReversed.summary,
    /preflight JSON public manifest boundary does not match the Markdown record\./,
    "the reversed mixed summary must preserve the invalid-record result",
  );
  assert.match(
    multiRecord.summary,
    new RegExp(
      `### \\[${multiRecord.recordPaths[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*- Validation: \\*\\*PASS\\*\\*[\\s\\S]*- Record result: \\*\\*BLOCKED \\(valid\\)\\*\\*`,
    ),
    "the valid record must remain represented after another record fails",
  );
  assert.match(
    multiRecord.summary,
    new RegExp(
      `### \\[${multiRecord.recordPaths[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*- Validation: \\*\\*FAIL\\*\\*[\\s\\S]*Missing-boundary reason[\\s\\S]*preflight JSON public manifest boundary does not match the Markdown record\\.`,
    ),
    "the mismatched record must contribute its sanitized checker reason",
  );
  assert.match(
    multiRecord.summary,
    new RegExp(
      `### \\[${multiRecord.recordPaths[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*- Validation: \\*\\*FAIL\\*\\*[\\s\\S]*Missing-boundary reason[\\s\\S]*changed Android preview validation record is missing from the checked-out commit\\.`,
    ),
    "the deleted record must contribute the fixed missing-record reason",
  );
  assert.equal(
    multiRecord.summary.match(
      /changed Android preview validation record is missing from the checked-out commit\./g,
    )?.length ?? 0,
    1,
    "deleting a record and its paired sidecar must contribute one fixed missing-record reason",
  );
  assert.ok(
    multiRecord.summary.indexOf(
      `### [${multiRecord.recordPaths[1]}]`,
    ) <
      multiRecord.summary.indexOf(
        `### [${multiRecord.recordPaths[2]}]`,
      ),
    "a record changed after the deletion must remain visible after the missing-record section",
  );
  assert.equal(
    multiRecord.summary.match(
      /- Validation: \*\*FAIL\*\*/g,
    )?.length ?? 0,
    2,
    "the summary must preserve the failure status for the invalid and deleted records",
  );
  assert.doesNotMatch(
    multiRecord.summary,
    /PRIVATE_MULTI_RECORD_EVIDENCE|Workspace curl returned HTTP 200|No physical phone was available/,
    "a multi-record summary must not expose evidence text from either record",
  );

  const allDeleted = runAndroidPreviewJob("all-deleted", [
    {
      timestamp: "20260915T120000Z",
      baseText: blockedRecord,
      text: blockedRecord,
      preflight: blockedPreflight,
      deleted: true,
    },
    {
      timestamp: "20260915T121000Z",
      baseText: blockedRecord,
      text: blockedRecord,
      preflight: blockedPreflight,
      deleted: true,
    },
  ]);
  assert.notEqual(
    allDeleted.result.status,
    0,
    "an Android preview change containing only deleted records must remain blocking",
  );
  assert.equal(
    allDeleted.checkerInvoked,
    false,
    "an all-deleted Android preview change must not invoke the record checker",
  );
  assert.deepEqual(
    allDeleted.checkerArgs,
    [],
    "an all-deleted Android preview change must not produce checker arguments",
  );
  assert.match(
    allDeleted.summary,
    /- Changed records checked: \*\*2\*\*/,
    "the all-deleted summary must report the exact number of deleted records",
  );
  for (const recordPath of allDeleted.recordPaths) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${allDeleted.baseSha}/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${allDeleted.baseSha}/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      allDeleted.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `each deleted Android record must have one base-revision link: ${recordPath}`,
    );
    assert.equal(
      allDeleted.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `each deleted Android record must have one validation section: ${recordPath}`,
    );
    assert.match(
      allDeleted.summary,
      new RegExp(
        `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/${allDeleted.baseSha}/${escapedPath}\\)[\\s\\S]*?- Validation: \\*\\*FAIL\\*\\*[\\s\\S]*?Missing-boundary reason[\\s\\S]*?changed Android preview validation record is missing from the checked-out commit\\.`,
      ),
      `each deleted Android record must report the fixed missing-record reason: ${recordPath}`,
    );
  }
  assert.equal(
    allDeleted.summary.match(
      /changed Android preview validation record is missing from the checked-out commit\./g,
    )?.length ?? 0,
    allDeleted.recordPaths.length,
    "the all-deleted summary must report one fixed missing-record reason per deleted record",
  );

  const changedSidecarOnlyPreflight = `${blockedPreflight}\n`;
  const mixedModeDefinitions = [
    {
      timestamp: "20260915T120000Z",
      mode: "record-only",
      text: blockedRecord,
    },
    {
      timestamp: "20260915T121500Z",
      mode: "sidecar-only",
      text: blockedRecord,
    },
    {
      timestamp: "20260915T123000Z",
      mode: "paired",
      baseText: blockedRecord,
      text: blockedRecord.replace(
        "Workspace curl returned HTTP 200.",
        "PRIVATE_MIXED_MODES_EVIDENCE Workspace curl returned HTTP 200.",
      ),
      preflight: mismatchedPreflight,
    },
  ];
  const mixedModes = runAndroidPreviewJob("mixed-modes", mixedModeDefinitions, {
    changedPreflight: changedSidecarOnlyPreflight,
  });
  const mixedModesReversed = runAndroidPreviewJob(
    "mixed-modes-reversed",
    mixedModeDefinitions,
    {
      changedPreflight: changedSidecarOnlyPreflight,
      diffOrder: "reverse",
    },
  );
  assert.notEqual(
    mixedModes.result.status,
    0,
    "a failing paired Android preview change must fail the mixed validation job",
  );
  assert.match(
    mixedModes.summary,
    /- Changed records checked: \*\*3\*\*/,
    "the mixed summary must count record-only, sidecar-only, and paired changes",
  );
  assert.deepEqual(
    mixedModes.checkerArgs,
    [
      [mixedModes.recordPaths[0], ""],
      [mixedModes.recordPaths[1], mixedModes.preflightPaths[1]],
      [mixedModes.recordPaths[2], mixedModes.preflightPaths[2]],
    ],
    "each mixed Android change must validate with only its own optional sidecar",
  );
  assert.deepEqual(
    mixedModesReversed.checkerArgs,
    mixedModes.checkerArgs,
    "reordering the pull request diff must not change each record's sidecar pairing",
  );
  assert.deepEqual(
    mixedModesReversed.recordPaths.map((recordPath) =>
      mixedModesReversed.summary.indexOf(`### [${recordPath}]`),
    ),
    [...mixedModesReversed.recordPaths]
      .sort()
      .map((recordPath) => mixedModesReversed.summary.indexOf(`### [${recordPath}]`)),
    "the mixed Android summary must keep sections in deterministic path order",
  );
  for (const recordPath of mixedModes.recordPaths) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      mixedModes.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `the mixed summary must include exactly one stable link for ${recordPath}`,
    );
    assert.equal(
      mixedModes.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `the mixed summary must include exactly one validation section for ${recordPath}`,
    );
  }
  assert.equal(
    mixedModes.summary.match(/- Validation: \*\*PASS\*\*/g)?.length ?? 0,
    2,
    "valid record-only and sidecar-only changes must remain visible after the paired failure",
  );
  assert.equal(
    mixedModes.summary.match(/- Validation: \*\*FAIL\*\*/g)?.length ?? 0,
    1,
    "the mixed summary must mark only the failing paired change as failed",
  );
  assert.match(
    mixedModes.summary,
    new RegExp(
      `### \\[${mixedModes.recordPaths[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*- Record result: \\*\\*BLOCKED \\(valid\\)\\*\\*`,
    ),
    "the record-only change must remain represented as valid",
  );
  assert.match(
    mixedModes.summary,
    new RegExp(
      `### \\[${mixedModes.recordPaths[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*- Record result: \\*\\*BLOCKED \\(valid\\)\\*\\*`,
    ),
    "the sidecar-only change must remain represented as valid",
  );
  assert.match(
    mixedModes.summary,
    new RegExp(
      `### \\[${mixedModes.recordPaths[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*Missing-boundary reason[\\s\\S]*preflight JSON public manifest boundary does not match the Markdown record\\.`,
    ),
    "the paired change must contribute its sanitized failure reason",
  );
  assert.doesNotMatch(
    mixedModes.summary,
    /PRIVATE_MIXED_MODES_EVIDENCE|Workspace curl returned HTTP 200|No physical phone was available/,
    "the mixed summary must not expose evidence text from any change mode",
  );

  const duplicatePreflight = blockedPreflight.replace(
    '"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"',
    '"status":"PASS","evidence":"DUPLICATE_PREFLIGHT_SENTINEL: raw-duplicate-preflight-content","evidence":"DUPLICATE_PREFLIGHT_SENTINEL: raw-duplicate-preflight-content"',
  );
  const duplicatePreflightRun = runAndroidPreviewJob(
    "duplicate-preflight",
    blockedRecord,
    {
      sidecarOnly: true,
      changedPreflight: duplicatePreflight,
    },
  );
  const duplicatePreflightFailure = [
    duplicatePreflightRun.result.stdout,
    duplicatePreflightRun.result.stderr,
  ].join("\n");
  const fixedRedactedSchemaMessage =
    "The Android preview preflight JSON artifact does not satisfy the redacted schema.";
  assert.notEqual(
    duplicatePreflightRun.result.status,
    0,
    "a duplicate Android preflight field must fail the release validation job",
  );
  assert.match(
    duplicatePreflightRun.summary,
    new RegExp(fixedRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the job summary must use the fixed redacted-schema contract message",
  );
  assert.match(
    duplicatePreflightFailure,
    new RegExp(fixedRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the surfaced checker failure must use the fixed redacted-schema contract message",
  );
  for (const [surfaceName, surface] of [
    ["job summary", duplicatePreflightRun.summary],
    ["surfaced checker failure", duplicatePreflightFailure],
  ]) {
    assert.doesNotMatch(
      surface,
      /DUPLICATE_PREFLIGHT_SENTINEL|raw-duplicate-preflight-content|public manifest HTTP 200 \(128 bytes\)/,
      `${surfaceName} must not expose the duplicate preflight value or raw artifact content`,
    );
  }

  const malformedPreflight =
    '{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"MALFORMED_PREFLIGHT_SENTINEL raw-malformed-preflight-content"}';
  const schemaInvalidPreflight = blockedPreflight.replace(
    "public manifest HTTP 200 (128 bytes)",
    "SCHEMA_INVALID_PREFLIGHT_SENTINEL raw-schema-invalid-preflight-content",
  );

  for (const {
    name,
    preflight,
    forbidden,
    description,
  } of [
    {
      name: "malformed-preflight",
      preflight: malformedPreflight,
      forbidden: /MALFORMED_PREFLIGHT_SENTINEL|raw-malformed-preflight-content/,
      description: "malformed",
    },
    {
      name: "schema-invalid-preflight",
      preflight: schemaInvalidPreflight,
      forbidden:
        /SCHEMA_INVALID_PREFLIGHT_SENTINEL|raw-schema-invalid-preflight-content/,
      description: "schema-invalid",
    },
  ]) {
    const run = runAndroidPreviewJob(name, blockedRecord, {
      sidecarOnly: true,
      changedPreflight: preflight,
    });
    const failure = [run.result.stdout, run.result.stderr].join("\n");

    assert.notEqual(
      run.result.status,
      0,
      `a ${description} Android preflight artifact must fail the release validation job`,
    );
    assert.match(
      run.summary,
      new RegExp(
        fixedRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `the ${description} job summary must use the fixed redacted-schema contract message`,
    );
    assert.match(
      failure,
      new RegExp(
        fixedRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `the ${description} checker failure must use the fixed redacted-schema contract message`,
    );
    for (const [surfaceName, surface] of [
      ["job summary", run.summary],
      ["surfaced checker failure", failure],
    ]) {
      assert.doesNotMatch(
        surface,
        forbidden,
        `the ${description} ${surfaceName} must not expose the marker or raw artifact content`,
      );
      assert.doesNotMatch(
        surface,
        /public manifest HTTP 200 \(128 bytes\)/,
        `the ${description} ${surfaceName} must not expose valid preflight artifact content`,
      );
    }
  }

  const sidecarOnly = runAndroidPreviewJob("sidecar-only", blockedRecord, {
    sidecarOnly: true,
    changedPreflight: mismatchedPreflight,
  });
  assert.notEqual(
    sidecarOnly.result.status,
    0,
    "a sidecar-only Android preflight edit must not bypass evidence validation",
  );
  assert.match(
    sidecarOnly.summary,
    /The preflight JSON public manifest boundary does not match the Markdown record\./,
    "the matching Markdown record must be checked with a changed sidecar",
  );

  const missingValidator = runAndroidPreviewJob(
    "missing-validator",
    blockedRecord,
    {
      sidecarOnly: true,
      changedPreflight: mismatchedPreflight,
      missingValidator: true,
    },
  );
  const missingValidatorFailure = [
    missingValidator.result.stdout,
    missingValidator.result.stderr,
  ].join("\n");
  const fixedValidatorDependencyMessage =
    "The Android preview evidence check is missing its delegated validator dependency boundary: artifacts/chat-app/scripts/validate-preview-startup.mjs is not present in the checked-out commit. Restore that validator before changing the evidence record.";
  assert.notEqual(
    missingValidator.result.status,
    0,
    "a changed Android record must fail when its delegated validator is missing",
  );
  assert.match(
    missingValidator.summary,
    new RegExp(
      fixedValidatorDependencyMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the summary must explain the missing delegated validator dependency",
  );
  assert.match(
    missingValidatorFailure,
    new RegExp(
      fixedValidatorDependencyMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the missing delegated validator diagnostic must be surfaced by the job",
  );
  assert.equal(
    missingValidator.checkerInvoked,
    false,
    "the job must report the missing delegated validator before invoking the checker",
  );
  assert.doesNotMatch(
    missingValidatorFailure,
    /Workspace curl returned HTTP 200|No physical phone was available/,
    "the missing delegated validator diagnostic must not expose evidence text",
  );
});

test("iOS preview evidence covers renamed records and blocks malformed changes", () => {
  const iosJob = workflow.jobs["ios-preview-evidence"];
  assert.ok(iosJob, "the release workflow must define the iOS preview job");
  assert.equal(
    iosJob.if,
    "${{ github.event_name == 'pull_request' }}",
    "iOS preview evidence must be isolated to pull requests",
  );

  const validationStep = iosJob.steps.find(
    (step) => step.name === "Validate changed iOS preview records",
  );
  assert.ok(validationStep, "the iOS preview job must validate changed records");
  assert.equal(
    validationStep.env.REVIEWED_REF,
    "${{ github.ref }}",
    "the iOS preview summary must use the trusted workflow ref",
  );
  assert.match(
    validationStep.run,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*echo "## Reviewed release revision"[\s\S]*Checked ref: `%s`[\s\S]*Resolved commit SHA: `%s`/,
    "the iOS preview summary must record the checked revision",
  );
  assert.ok(
    validationStep.run.indexOf('echo "## Reviewed release revision"') <
      validationStep.run.indexOf('>> "$GITHUB_STEP_SUMMARY"'),
    "iOS revision metadata must precede every preview summary branch",
  );
  assert.doesNotMatch(
    validationStep.run,
    /secrets\.|E2E_CHAT_URL|E2E_API_URL|CLERK_SECRET_KEY|DATABASE_URL/,
    "iOS preview revision metadata must not expose secrets or private URLs",
  );
  assert.match(
    validationStep.run,
    /No iOS preview validation records or preflight artifacts changed; nothing to validate\./,
    "zero changed records must skip successfully",
  );
  assert.match(
    validationStep.run,
    /bash scripts\/run-untrusted-checker\.sh pnpm run validate:ios-preview-evidence -- "\$\{checker_args\[@\]\}"/,
    "changed iOS records must run the focused checker",
  );
  assert.match(
    validationStep.run,
    /validator_directory="artifacts\/chat-app\/scripts"[\s\S]*validator_file="validate-preview-startup\.mjs"[\s\S]*validator_path="\$\{validator_directory\}\/\$\{validator_file\}"[\s\S]*if \[\[ ! -f "\$validator_path" \]\][\s\S]*validator_failure_reason=/,
    "the iOS job must check its delegated validator dependency before checking changed records",
  );
  assert.match(
    validationStep.run,
    /elif \[\[ -n "\$validator_failure_reason" \]\][\s\S]*reasons="\$validator_failure_reason"[\s\S]*else[\s\S]*validation_output="\$\(/,
    "a missing delegated iOS validator must produce a fixed reason without invoking the record checker",
  );
  assert.ok(
    validationStep.run.includes(
      `reasons="$(printf '%s\\n' "$validation_output" | sed -n '/^- /p')"`
    ),
    "only fixed checker reason lines may enter the iOS summary",
  );
  assert.doesNotMatch(
    validationStep.run,
    /cat\s+"\$record_path"|validation_output.*GITHUB_STEP_SUMMARY/,
    "the iOS job must not print iOS record evidence into the summary",
  );
  assert.match(
    validationStep.run,
    /record_revision="\$GITHUB_SHA"[\s\S]*if \[\[ ! -f "\$record_path" \]\][\s\S]*record_revision="\$IOS_PREVIEW_BASE_SHA"[\s\S]*record_url="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/blob\/\$\{record_revision\}\/\$\{record_path\}"/,
    "each changed iOS record must receive a GitHub link, using the base revision when the record was deleted",
  );

  function runIosPreviewJob(
    name,
    {
      recordText,
      baseRecordText = "# iOS preview validation record\n",
      preflightText,
      basePreflightText,
      updateOnlyPreflight = false,
      deleteRecord = false,
      renameRecord = false,
      missingValidator = false,
    },
  ) {
    const fixtureRoot = path.join(testRoot, `ios-preview-${name}`);
    const recordDefinitions = Array.isArray(recordText)
      ? recordText
      : [
          {
            timestamp: renameRecord
              ? "20260915T121500Z"
              : "20260915T120000Z",
            baseTimestamp: "20260915T120000Z",
            text: recordText,
            baseText: baseRecordText,
            preflight: preflightText,
            basePreflight: basePreflightText,
            updateOnlyPreflight,
            deleteRecord,
          },
        ];
    const recordPaths = recordDefinitions.map(({ timestamp }) =>
      path.join(
        fixtureRoot,
        `artifacts/chat-app/test-results/encrypted-room-recovery/ios/${timestamp}/validation-record.md`,
      ),
    );
    const baseRecordPaths = recordDefinitions.map(
      ({ timestamp, baseTimestamp = "20260915T120000Z" }) =>
        path.join(
          fixtureRoot,
          `artifacts/chat-app/test-results/encrypted-room-recovery/ios/${renameRecord ? baseTimestamp : timestamp}/validation-record.md`,
        ),
    );
    const preflightPaths = recordDefinitions.map(({ timestamp }) =>
      path.join(
        fixtureRoot,
        `artifacts/chat-app/test-results/encrypted-room-recovery/ios/${timestamp}/ios-preview-preflight.json`,
      ),
    );
    const basePreflightPaths = recordDefinitions.map(
      ({ timestamp, baseTimestamp = "20260915T120000Z" }) =>
        path.join(
          fixtureRoot,
          `artifacts/chat-app/test-results/encrypted-room-recovery/ios/${renameRecord ? baseTimestamp : timestamp}/ios-preview-preflight.json`,
        ),
    );
    const recordPath = recordPaths[0];
    const baseRecordPath = baseRecordPaths[0];
    const summaryPath = path.join(fixtureRoot, "summary.md");
    const runnerPath = path.join(fixtureRoot, "run-job.sh");
    const binDirectory = path.join(fixtureRoot, "bin");
    const validatorPath = path.join(
      fixtureRoot,
      "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    );
    for (const record of [...recordPaths, ...baseRecordPaths]) {
      mkdirSync(path.dirname(record), { recursive: true });
    }
    mkdirSync(binDirectory, { recursive: true });
    if (!missingValidator) {
      mkdirSync(path.dirname(validatorPath), { recursive: true });
      writeFileSync(validatorPath, "// contract fixture\n");
    }
    for (const [
      index,
      { text, baseText, basePreflight },
    ] of recordDefinitions.entries()) {
      writeFileSync(baseRecordPaths[index], baseText ?? text);
      if (basePreflight !== undefined) {
        writeFileSync(basePreflightPaths[index], basePreflight);
      }
    }

    const git = (args) => {
      const result = spawnSync(gitPath, args, {
        cwd: fixtureRoot,
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
      );
    };
    git(["init", "--quiet"]);
    git(["config", "user.email", "contract-test@example.invalid"]);
    git(["config", "user.name", "Contract Test"]);
    writeFileSync(path.join(fixtureRoot, "README.md"), "base\n");
    const baseFiles = [
      "README.md",
      ...baseRecordPaths,
      ...recordDefinitions.flatMap(({ basePreflight }, index) =>
        basePreflight === undefined ? [] : [basePreflightPaths[index]],
      ),
      ...(!missingValidator ? [validatorPath] : []),
    ];
    git(["add", ...baseFiles]);
    git(["commit", "--quiet", "-m", "base iOS preview record"]);
    const baseSha = spawnSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).stdout.trim();

    for (const [
      index,
      {
        text,
        preflight,
        basePreflight,
        updateOnlyPreflight: definitionUpdatesOnlyPreflight = false,
        deleteRecord: definitionDeletesRecord = false,
      },
    ] of recordDefinitions.entries()) {
      if (definitionDeletesRecord) {
        rmSync(baseRecordPaths[index]);
        if (basePreflight !== undefined) {
          rmSync(basePreflightPaths[index]);
        }
      } else if (renameRecord) {
        mkdirSync(path.dirname(recordPaths[index]), { recursive: true });
        renameSync(baseRecordPaths[index], recordPaths[index]);
        if (basePreflight !== undefined) {
          renameSync(basePreflightPaths[index], preflightPaths[index]);
        }
        writeFileSync(recordPaths[index], text);
        if (preflight !== undefined) {
          writeFileSync(preflightPaths[index], preflight);
        }
      } else if (definitionUpdatesOnlyPreflight) {
        if (preflight !== undefined) {
          writeFileSync(preflightPaths[index], preflight);
        }
      } else {
        writeFileSync(recordPaths[index], text);
        if (preflight !== undefined) {
          writeFileSync(preflightPaths[index], preflight);
        }
      }
    }
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "changed iOS preview record"]);
    const headSha = spawnSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).stdout.trim();

    const checkerInvokedPath = path.join(fixtureRoot, "checker-invoked");
    const checkerArgsLogPath = path.join(fixtureRoot, "checker-args.log");
    writeStub(
      binDirectory,
      "pnpm",
      `set -euo pipefail\ntouch ${shellQuote(checkerInvokedPath)}\nchecker_args=()\nfound_separator=0\nfor arg in "$@"; do\n  if [[ "$arg" == "--" ]]; then\n    found_separator=1\n    continue\n  fi\n  if ((found_separator)); then\n    checker_args+=("$arg")\n  fi\ndone\nprintf '%s\\t%s\\n' "\${checker_args[0]}" "\${checker_args[1]:-}" >> "$IOS_PREVIEW_ARGS_LOG"\nexec bash "$IOS_PREVIEW_CHECKER" "\${checker_args[@]}"`,
    );
    mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, untrustedCheckerWrapperScript),
      readFileSync(path.join(workspaceRoot, untrustedCheckerWrapperScript)),
    );
    chmodSync(path.join(fixtureRoot, untrustedCheckerWrapperScript), 0o755);
    writeFileSync(
      path.join(fixtureRoot, workflowOutputSafetyScript),
      readFileSync(path.join(workspaceRoot, workflowOutputSafetyScript)),
    );
    chmodSync(path.join(fixtureRoot, workflowOutputSafetyScript), 0o755);
    writeFileSync(runnerPath, `#!${bashPath}\n${validationStep.run}\n`);
    chmodSync(runnerPath, 0o755);

    const result = spawnSync(bashPath, [runnerPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
        IOS_PREVIEW_BASE_SHA: baseSha,
        IOS_PREVIEW_HEAD_SHA: headSha,
        IOS_PREVIEW_CHECKER: path.join(
          workspaceRoot,
          "scripts/check-ios-preview-evidence.sh",
        ),
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: "example/chat-app",
        REVIEWED_REF: "refs/heads/mobile-v0.0.0",
        GITHUB_SHA: headSha,
        GITHUB_STEP_SUMMARY: summaryPath,
        IOS_PREVIEW_ARGS_LOG: checkerArgsLogPath,
      },
    });
    return {
      result,
      baseSha,
      headSha,
      baseRecordPath: path.relative(fixtureRoot, baseRecordPath),
      recordPath: path.relative(fixtureRoot, recordPath),
      baseRecordPaths: baseRecordPaths.map((record) =>
        path.relative(fixtureRoot, record),
      ),
      recordPaths: recordPaths.map((record) =>
        path.relative(fixtureRoot, record),
      ),
      preflightPaths: preflightPaths.map((preflight) =>
        path.relative(fixtureRoot, preflight),
      ),
      summary: readFileSync(summaryPath, "utf8"),
      checkerInvoked: existsSync(checkerInvokedPath),
      checkerArgs: existsSync(checkerArgsLogPath)
        ? readFileSync(checkerArgsLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t"))
        : [],
    };
  }

  const malformed = runIosPreviewJob("malformed", {
    recordText: `# iOS preview validation record

PRIVATE_IOS_EVIDENCE_MARKER

| Raw evidence | IOS_CHANGED_RECORD_RAW_CONTENT_7f2a |
`,
  });
  const malformedFailure = [
    malformed.result.stdout,
    malformed.result.stderr,
  ].join("\n");
  const malformedRecordLink = new RegExp(
    `\\[${malformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${malformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
  );
  const malformedFixedReason =
    "Evidence record must declare **Result: PASS**, **Result: BLOCKED**, or **Result: FAIL**.";
  assert.notEqual(
    malformed.result.status,
    0,
    "a malformed changed iOS preview record must fail the job",
  );
  assert.match(
    malformed.summary,
    /Validation: \*\*FAIL\*\*[\s\S]*Evidence record must declare/,
    "the failed summary must report a fixed checker reason",
  );
  assert.match(
    malformed.summary,
    malformedRecordLink,
    "the failed summary must keep a stable link to the changed iOS record",
  );
  assert.match(
    malformedFailure,
    new RegExp(
      malformedFixedReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the surfaced iOS checker failure must report the fixed reason",
  );
  for (const [surfaceName, surface] of [
    ["job summary", malformed.summary],
    ["surfaced checker failure", malformedFailure],
  ]) {
    assert.doesNotMatch(
      surface,
      /PRIVATE_IOS_EVIDENCE_MARKER|IOS_CHANGED_RECORD_RAW_CONTENT_7f2a/,
      `the malformed iOS ${surfaceName} must not expose the marker or raw record content`,
    );
  }

  const blockedRecord = `# iOS preview validation record

**Result: BLOCKED — no physical iPhone was available**

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | public manifest HTTP 200 (128 bytes) |
| Local handoff probe (manifest and bundle) | NOT_RUN | Local manifest/bundle probe not run — no successful probe result was recorded |
| Expo Go launch on physical iPhone | BLOCKED | No physical phone was available. |
| Server-side native request evidence | BLOCKED | No native request was available. |
`;
  const missingValidator = runIosPreviewJob("missing-validator", {
    recordText: blockedRecord,
    baseRecordText: blockedRecord,
    renameRecord: true,
    missingValidator: true,
  });
  const missingValidatorFailure = [
    missingValidator.result.stdout,
    missingValidator.result.stderr,
  ].join("\n");
  const fixedValidatorDependencyMessage =
    "The iOS preview evidence check is missing its delegated validator dependency boundary: artifacts/chat-app/scripts/validate-preview-startup.mjs is not present in the checked-out commit. Restore that validator before changing the evidence record.";
  assert.notEqual(
    missingValidator.result.status,
    0,
    "a changed iOS record must fail when its delegated validator is missing",
  );
  assert.match(
    missingValidator.summary,
    new RegExp(
      fixedValidatorDependencyMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the iOS summary must explain the missing delegated validator dependency",
  );
  assert.match(
    missingValidatorFailure,
    new RegExp(
      fixedValidatorDependencyMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the missing delegated iOS validator diagnostic must be surfaced by the job",
  );
  assert.equal(
    missingValidator.checkerInvoked,
    false,
    "the iOS job must report the missing delegated validator before invoking the checker",
  );
  assert.doesNotMatch(
    missingValidatorFailure,
    /Workspace curl returned HTTP 200|No physical phone was available/,
    "the missing delegated iOS validator diagnostic must not expose evidence text",
  );

  const blocked = runIosPreviewJob("blocked", {
    recordText: blockedRecord,
    baseRecordText: blockedRecord,
    renameRecord: true,
  });
  assert.equal(
    blocked.result.status,
    0,
    "a valid physical-phone BLOCKED record must pass the job",
  );
  assert.match(
    blocked.summary,
    /Validation: \*\*PASS\*\*[\s\S]*Record result: \*\*BLOCKED \(valid physical-phone handoff unavailable\)\*\*/,
    "the summary must distinguish a valid physical-phone BLOCKED record",
  );
  assert.match(
    blocked.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a renamed valid BLOCKED record must count as one changed record",
  );
  assert.match(
    blocked.summary,
    new RegExp(
      `\\[${blocked.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${blocked.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "a renamed valid BLOCKED record must be linked at its new path",
  );
  assert.doesNotMatch(
    blocked.summary,
    new RegExp(blocked.baseRecordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "a renamed valid BLOCKED record must not leave its old path in the summary",
  );

  const publicFailureRecord = `# iOS preview validation record

**Result: FAIL — the public preview edge was unavailable**

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | FAIL | Public manifest probe failed — no successful probe result was recorded |
| Local handoff probe (manifest and bundle) | NOT_RUN | Local manifest/bundle probe not run — no successful probe result was recorded |
| Expo Go launch on physical iPhone | FAIL | Physical launch was not attempted after the public failure. |
| Server-side native request evidence | FAIL | Native request evidence was not available after the public failure. |
`;
  const publicFailure = runIosPreviewJob("public-failure", {
    recordText: publicFailureRecord,
    baseRecordText: publicFailureRecord,
    renameRecord: true,
  });
  assert.equal(
    publicFailure.result.status,
    0,
    "a public-edge FAIL record must pass record-shape validation",
  );
  assert.match(
    publicFailure.summary,
    /Validation: \*\*PASS\*\*[\s\S]*Record result: \*\*FAIL \(public edge\)\*\*/,
    "the summary must distinguish a public-edge FAIL record",
  );
  assert.match(
    publicFailure.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a renamed public-edge FAIL record must count as one changed record",
  );
  assert.match(
    publicFailure.summary,
    new RegExp(
      `\\[${publicFailure.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${publicFailure.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "a renamed public-edge FAIL record must be linked at its new path",
  );

  const iosBlockedPreflight = `{
  "schema": "ios-preview-handoff-preflight/v1",
  "platform": "ios",
  "boundaries": {
    "publicManifestReachability": {
      "status": "PASS",
      "evidence": "public manifest HTTP 200 (128 bytes)"
    },
    "localHandoffProbe": {
      "status": "NOT_RUN",
      "evidence": "Local manifest/bundle probe not run — no successful probe result was recorded"
    },
    "expoGoLaunch": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires a physical iPhone running stock Expo Go."
    },
    "serverNativeRequestEvidence": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires filtered Metro or API evidence from that physical Expo Go session."
    }
  }
}
`;
  const iosPublicFailurePreflight = iosBlockedPreflight
    .replace(
      '"status": "PASS",\n      "evidence": "public manifest HTTP 200 (128 bytes)"',
      '"status": "FAIL",\n      "evidence": "Public manifest probe failed — no successful probe result was recorded"',
    );

  const multipleRenamed = runIosPreviewJob("multiple-renamed", {
    renameRecord: true,
    recordText: [
      {
        baseTimestamp: "20260915T120000Z",
        timestamp: "20260915T121500Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "**Result: BLOCKED",
          "**Result: PASS",
        ),
        basePreflight: iosBlockedPreflight,
        preflight: iosBlockedPreflight,
      },
      {
        baseTimestamp: "20260915T120500Z",
        timestamp: "20260915T122000Z",
        baseText: blockedRecord,
        text: blockedRecord,
        basePreflight: iosBlockedPreflight,
        preflight: iosBlockedPreflight,
      },
      {
        baseTimestamp: "20260915T121000Z",
        timestamp: "20260915T122500Z",
        baseText: publicFailureRecord,
        text: publicFailureRecord,
        basePreflight: iosPublicFailurePreflight,
        preflight: iosPublicFailurePreflight,
      },
    ],
  });
  assert.notEqual(
    multipleRenamed.result.status,
    0,
    "one malformed renamed iOS record must fail the job without hiding later valid records",
  );
  assert.match(
    multipleRenamed.summary,
    /- Changed records checked: \*\*3\*\*/,
    "the summary must report the exact number of renamed destination records",
  );
  assert.deepEqual(
    multipleRenamed.checkerArgs,
    multipleRenamed.recordPaths.map((recordPath, index) => [
      recordPath,
      multipleRenamed.preflightPaths[index],
    ]),
    "the checker must receive each renamed iOS record with its matching sidecar exactly once",
  );
  for (const [index, recordPath] of multipleRenamed.recordPaths.entries()) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      multipleRenamed.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `each renamed iOS destination must have one stable link: ${recordPath}`,
    );
    assert.equal(
      multipleRenamed.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `each renamed iOS destination must have one validation section: ${recordPath}`,
    );
    assert.match(
      multipleRenamed.summary,
      new RegExp(
        `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?- Validation: \\*\\*(?:PASS|FAIL)\\*\\*`,
      ),
      `each renamed iOS destination must report its validation result: ${recordPath}`,
    );
    assert.doesNotMatch(
      multipleRenamed.summary,
      new RegExp(
        multipleRenamed.baseRecordPaths[index].replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
      ),
      `the renamed iOS summary must not retain the old path for ${recordPath}`,
    );
  }
  const blockedDestination = multipleRenamed.recordPaths[1].replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  assert.match(
    multipleRenamed.summary,
    new RegExp(
      `### \\[${blockedDestination}\\][\\s\\S]*?Record result: \\*\\*BLOCKED \\(valid physical-phone handoff unavailable\\)\\*\\*`,
    ),
    "a valid BLOCKED result must remain visible after an earlier renamed record fails",
  );
  const publicFailureDestination = multipleRenamed.recordPaths[2].replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  assert.match(
    multipleRenamed.summary,
    new RegExp(
      `### \\[${publicFailureDestination}\\][\\s\\S]*?Record result: \\*\\*FAIL \\(public edge\\)\\*\\*`,
    ),
    "a valid public-edge FAIL result must remain visible after an earlier renamed record fails",
  );

  const renamedMalformed = runIosPreviewJob("renamed-malformed", {
    baseRecordText: blockedRecord,
    recordText: blockedRecord.replace("**Result: BLOCKED", "**Result: PASS"),
    renameRecord: true,
  });
  assert.notEqual(
    renamedMalformed.result.status,
    0,
    "a malformed renamed iOS preview record must fail the job",
  );
  assert.match(
    renamedMalformed.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a malformed renamed record must count as one changed record",
  );
  assert.match(
    renamedMalformed.summary,
    new RegExp(
      `\\[${renamedMalformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${renamedMalformed.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "a malformed renamed record must be linked at its new path",
  );
  assert.doesNotMatch(
    renamedMalformed.summary,
    new RegExp(
      renamedMalformed.baseRecordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "a malformed renamed record must not be treated as a deleted old path",
  );
  assert.match(
    renamedMalformed.summary,
    /Validation: \*\*FAIL\*\*[\s\S]*PASS records must include a real Device model value\./,
    "a malformed renamed record must report the fixed checker reason",
  );

  const deleted = runIosPreviewJob("deleted", {
    recordText: "# iOS preview validation record\n",
    deleteRecord: true,
  });
  assert.notEqual(
    deleted.result.status,
    0,
    "a deleted changed iOS preview record must fail the job",
  );
  assert.match(
    deleted.summary,
    /changed iOS preview validation record is missing/,
    "the summary must identify the missing changed iOS record",
  );
  assert.match(
    deleted.summary,
    new RegExp(
      `\\[${deleted.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.example/example/chat-app/blob/${deleted.baseSha}/${deleted.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
    ),
    "a deleted iOS record must link to its base revision so reviewers can inspect it",
  );
  assert.doesNotMatch(
    deleted.summary,
    new RegExp(
      `https://github\\.example/example/chat-app/blob/${deleted.headSha}/${deleted.recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    "a deleted iOS record must not link to the missing pull request head path",
  );

  const deletedAndPresentIos = runIosPreviewJob("deleted-and-present", {
    recordText: [
      {
        baseTimestamp: "20260915T120000Z",
        timestamp: "20260915T120000Z",
        baseText: blockedRecord,
        text: blockedRecord,
        basePreflight: iosBlockedPreflight,
        preflight: iosBlockedPreflight,
        deleteRecord: true,
      },
      {
        baseTimestamp: "20260915T120500Z",
        timestamp: "20260915T120500Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "No physical phone was available.",
          "PRIVATE_IOS_PRESENT_RECORD_EVIDENCE No physical phone was available.",
        ),
        basePreflight: iosBlockedPreflight,
        preflight: iosBlockedPreflight,
      },
    ],
  });
  assert.notEqual(
    deletedAndPresentIos.result.status,
    0,
    "a deleted iOS record must keep the release summary blocked",
  );
  assert.match(
    deletedAndPresentIos.summary,
    /- Changed records checked: \*\*2\*\*/,
    "the deleted and present iOS summary must count both changed records",
  );
  const deletedIosPath = deletedAndPresentIos.recordPaths[0];
  const presentIosPath = deletedAndPresentIos.recordPaths[1];
  const deletedIosBaseLink = `https://github.example/example/chat-app/blob/${deletedAndPresentIos.baseSha}/${deletedIosPath}`;
  const presentIosHeadLink = `https://github.example/example/chat-app/blob/${deletedAndPresentIos.headSha}/${presentIosPath}`;
  const deletedIosSection = `### [${deletedIosPath}](${deletedIosBaseLink})`;
  const presentIosSection = `### [${presentIosPath}](${presentIosHeadLink})`;
  assert.equal(
    deletedAndPresentIos.summary.split(deletedIosBaseLink).length - 1,
    1,
    "a deleted iOS record must have exactly one link to its base revision",
  );
  assert.equal(
    deletedAndPresentIos.summary.split(presentIosHeadLink).length - 1,
    1,
    "a present iOS record must have exactly one link to the pull request head",
  );
  assert.equal(
    deletedAndPresentIos.summary.split(deletedIosSection).length - 1,
    1,
    "a deleted record and its deleted sidecar must produce one iOS summary section",
  );
  assert.equal(
    deletedAndPresentIos.summary.split(presentIosSection).length - 1,
    1,
    "a present iOS record must produce one summary section",
  );
  assert.doesNotMatch(
    deletedAndPresentIos.summary,
    new RegExp(
      `https://github\\.example/example/chat-app/blob/${deletedAndPresentIos.headSha}/${deletedIosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    "a deleted iOS record must not use the pull request head link",
  );
  assert.doesNotMatch(
    deletedAndPresentIos.summary,
    /PRIVATE_IOS_PRESENT_RECORD_EVIDENCE/,
    "the iOS summary must not expose present-record evidence markers",
  );

  const malformedIosPreflight =
    '{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"MALFORMED_IOS_PREFLIGHT_SENTINEL raw-malformed-ios-preflight-content"}';
  const schemaInvalidIosPreflight = iosBlockedPreflight.replace(
    "public manifest HTTP 200 (128 bytes)",
    "SCHEMA_INVALID_IOS_PREFLIGHT_SENTINEL raw-schema-invalid-ios-preflight-content",
  );
  const fixedIosRedactedSchemaMessage =
    "The iOS preview preflight JSON artifact does not satisfy the redacted schema.";

  for (const {
    name,
    preflight,
    forbidden,
    description,
  } of [
    {
      name: "malformed-preflight",
      preflight: malformedIosPreflight,
      forbidden:
        /MALFORMED_IOS_PREFLIGHT_SENTINEL|raw-malformed-ios-preflight-content/,
      description: "malformed",
    },
    {
      name: "schema-invalid-preflight",
      preflight: schemaInvalidIosPreflight,
      forbidden:
        /SCHEMA_INVALID_IOS_PREFLIGHT_SENTINEL|raw-schema-invalid-ios-preflight-content/,
      description: "schema-invalid",
    },
  ]) {
    const run = runIosPreviewJob(name, {
      recordText: blockedRecord,
      baseRecordText: blockedRecord,
      basePreflightText: iosBlockedPreflight,
      preflightText: preflight,
      updateOnlyPreflight: true,
    });
    const failure = [run.result.stdout, run.result.stderr].join("\n");

    assert.notEqual(
      run.result.status,
      0,
      `a ${description} iOS preflight artifact must fail the release validation job`,
    );
    assert.match(
      run.summary,
      new RegExp(
        fixedIosRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `the ${description} iOS job summary must use the fixed redacted-schema contract message`,
    );
    assert.match(
      failure,
      new RegExp(
        fixedIosRedactedSchemaMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `the ${description} iOS checker failure must use the fixed redacted-schema contract message`,
    );
    for (const [surfaceName, surface] of [
      ["job summary", run.summary],
      ["surfaced checker failure", failure],
    ]) {
      assert.doesNotMatch(
        surface,
        forbidden,
        `the ${description} iOS ${surfaceName} must not expose the marker or raw artifact content`,
      );
      assert.doesNotMatch(
        surface,
        /public manifest HTTP 200 \(128 bytes\)/,
        `the ${description} iOS ${surfaceName} must not expose valid preflight artifact content`,
      );
    }
  }

  const preflightOnly = runIosPreviewJob("preflight-only", {
    recordText: blockedRecord,
    baseRecordText: blockedRecord,
    basePreflightText: iosBlockedPreflight,
    preflightText: `{
  "schema": "ios-preview-handoff-preflight/v1",
  "platform": "ios",
  "boundaries": {
    "publicManifestReachability": {
      "status": "PASS",
      "evidence": "public manifest HTTP 200 (129 bytes)"
    },
    "localHandoffProbe": {
      "status": "NOT_RUN",
      "evidence": "Local manifest/bundle probe not run — no successful probe result was recorded"
    },
    "expoGoLaunch": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires a physical iPhone running stock Expo Go."
    },
    "serverNativeRequestEvidence": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires filtered Metro or API evidence from that physical Expo Go session."
    }
  }
}
`,
    updateOnlyPreflight: true,
  });
  assert.notEqual(
    preflightOnly.result.status,
    0,
    "a changed iOS preflight artifact with a tampered byte count must fail its paired record",
  );
  assert.match(
    [preflightOnly.result.stdout, preflightOnly.result.stderr].join("\n"),
    /preflight JSON public manifest evidence does not match the Markdown record/,
    "a preflight-only iOS byte-count mismatch must report the fixed paired-evidence diagnostic",
  );
  assert.match(
    preflightOnly.summary,
    /- Changed records checked: \*\*1\*\*/,
    "a preflight-only iOS change must still count its paired validation record",
  );

  const changedIosPreflight = iosBlockedPreflight.replace(
    "public manifest HTTP 200 (128 bytes)",
    "public manifest HTTP 200 (256 bytes)",
  );
  const pairedAlongsideRecord = runIosPreviewJob("paired-alongside-record", {
    recordText: [
      {
        timestamp: "20260915T120000Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "Public edge was reachable.",
          "Public edge remained reachable.",
        ),
        basePreflight: iosBlockedPreflight,
        preflight: changedIosPreflight,
      },
      {
        timestamp: "20260915T120500Z",
        baseText: blockedRecord,
        text: blockedRecord.replace(
          "Public edge was reachable.",
          "Public edge was reachable after a second record change.",
        ),
      },
    ],
  });
  assert.notEqual(
    pairedAlongsideRecord.result.status,
    0,
    "a changed iOS record and sibling preflight with a tampered byte count must fail",
  );
  assert.match(
    [pairedAlongsideRecord.result.stdout, pairedAlongsideRecord.result.stderr].join(
      "\n",
    ),
    /preflight JSON public manifest evidence does not match the Markdown record/,
    "a paired iOS byte-count mismatch must report the fixed paired-evidence diagnostic",
  );
  assert.match(
    pairedAlongsideRecord.summary,
    /Validation: \*\*FAIL\*\*/,
    "a paired iOS byte-count mismatch must fail the release summary",
  );
  assert.deepEqual(
    pairedAlongsideRecord.checkerArgs,
    [
      [
        pairedAlongsideRecord.recordPaths[0],
        pairedAlongsideRecord.preflightPaths[0],
      ],
    ],
    "the iOS checker must receive the changed sidecar with its record without duplicating it before the job fails fast",
  );
  for (const recordPath of pairedAlongsideRecord.recordPaths.slice(0, 1)) {
    const escapedPath = recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordLinkPattern = new RegExp(
      `\\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)`,
      "g",
    );
    const recordSectionPattern = new RegExp(
      `### \\[${escapedPath}\\]\\(https://github\\.example/example/chat-app/blob/[^)]+/${escapedPath}\\)[\\s\\S]*?(?=\\n### |$)`,
      "g",
    );
    assert.equal(
      pairedAlongsideRecord.summary.match(recordLinkPattern)?.length ?? 0,
      1,
      `each changed iOS record must have one stable link: ${recordPath}`,
    );
    assert.equal(
      pairedAlongsideRecord.summary.match(recordSectionPattern)?.length ?? 0,
      1,
      `each changed iOS record must have one validation section: ${recordPath}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Static script contracts
// ---------------------------------------------------------------------------

/**
 * Variables that hold fixed text: assigned exactly once, to a literal without
 * any expansion, and never touched by anything else (no `read`, `local`,
 * `+=`, `printf -v`, ...). Anything derived from the environment fails this.
 */
function scriptConstants(source) {
  const literalValuePattern = /^(?:"[^"$`\\]*"|'[^'$`]*'|[^\s$`"'\\;|&<>()]*)$/;
  const constants = new Set();
  for (const line of source.split("\n")) {
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!assignment || !literalValuePattern.test(assignment[2])) {
      continue;
    }
    const name = assignment[1];
    const nonExpansionMentions = source.match(
      new RegExp(String.raw`(?<![$A-Za-z0-9_{])${name}\b`, "g"),
    );
    if (nonExpansionMentions?.length === 1) {
      constants.add(name);
    }
  }
  return constants;
}

function analyzeDiagnostics(script) {
  const { source, contract, locate } = script;
  const allowlist = new Set(contract.diagnosticVariableAllowlist);
  const constants = scriptConstants(source);
  const callPattern = new RegExp(
    String.raw`(?:^|[\s;&|{(])${contract.diagnosticFunction}\s+(.*)$`,
  );
  const problems = [];
  source.split("\n").forEach((line, index) => {
    const call = line.match(callPattern);
    if (!call) {
      return;
    }
    const message = call[1];
    const location = locate(index + 1);
    if (/\$\(|`|\$\{!/.test(message)) {
      problems.push(
        `${location}: diagnostic uses command substitution or indirect expansion; diagnostics must be fixed text.`,
      );
    }
    for (const [, name] of message.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!allowlist.has(name) && !constants.has(name)) {
        problems.push(
          `${location}: diagnostic interpolates $${name}; only literal script constants and ${[
            ...allowlist,
          ].join(", ")} may appear in diagnostics.`,
        );
      }
    }
  });
  return problems;
}

function functionBodyLines(script, functionName) {
  const lines = script.source.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(String.raw`^${functionName}\(\)\s*\{`).test(line),
  );
  assert.notEqual(
    start,
    -1,
    `expected ${script.relativePath} to define ${functionName}`,
  );
  const end = lines.findIndex((line, index) => index > start && line === "}");
  assert.notEqual(end, -1, `expected ${functionName} to close at column 0`);
  return lines
    .slice(start + 1, end)
    .map((line, offset) => ({ line, lineNumber: start + offset + 2 }));
}

function analyzeSummaryFunction(script) {
  const problems = [];
  for (const { line, lineNumber } of functionBodyLines(
    script,
    script.contract.summaryFunction,
  )) {
    for (const name of script.privateNames.keys()) {
      if (variableReferencePattern(name).test(line)) {
        problems.push(
          `${script.locate(lineNumber)}: the summary expands ${name}; summaries must only contain fixed text and prerequisite statuses.`,
        );
      }
    }
    if (indirectExpansionPattern.test(line)) {
      problems.push(
        `${script.locate(lineNumber)}: the summary uses indirect expansion.`,
      );
    }
  }
  return problems;
}

const outputCommandPattern = /(^|[\s;&|{(])(echo|printf|cat|tee)(\s|$)/;
const logOrSummarySinkPattern = />&2|GITHUB_STEP_SUMMARY/;
const heredocStartPattern =
  /(?:^|[^<])<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1(?!<)/;

function evidenceRedirectPatternFor(contract) {
  const variable = contract.evidenceDirectoryVariable;
  return variable
    ? new RegExp(String.raw`>>?\s*"?\$\{?${variable}\}?/`)
    : /(?!)/;
}

function expandedPrivateNames(line, privateNames) {
  return [...privateNames.keys()].filter((name) =>
    variableReferencePattern(name).test(line),
  );
}

/**
 * Follows every expansion of a private value through a script: credentials
 * may never be expanded, identifiers may only be written into evidence files
 * (when the script has an evidence directory at all), and nothing private may
 * reach a diagnostic, stderr, or the step summary.
 */
function analyzePrivateValueFlow(script) {
  const { source, contract, privateNames, locate } = script;
  const evidenceRedirectPattern = evidenceRedirectPatternFor(contract);
  const diagnosticPattern = new RegExp(contract.diagnosticFunction);
  const evidenceHint = contract.evidenceDirectoryVariable
    ? `an evidence file under ${contract.evidenceDirectoryVariable}`
    : "an evidence file (this script has none)";
  const problems = [];
  let heredoc = null;

  source.split("\n").forEach((line, index) => {
    const location = locate(index + 1);

    if (heredoc) {
      if (line.trim() === heredoc.terminator) {
        heredoc = null;
        return;
      }
      for (const name of expandedPrivateNames(line, privateNames)) {
        const kind = privateNames.get(name);
        if (kind === "credential") {
          problems.push(
            `${location}: expands ${name}; credentials may only be exported by name for the native tooling.`,
          );
        } else if (!heredoc.writesEvidence) {
          problems.push(
            `${location}: ${name} is written by a heredoc that is not ${evidenceHint}.`,
          );
        } else if (kind !== "identifier") {
          problems.push(
            `${location}: ${name} is recorded in evidence; only audited candidate identifiers may be written there.`,
          );
        }
      }
      return;
    }

    const heredocStart = line.match(heredocStartPattern);
    if (heredocStart) {
      heredoc = {
        terminator: heredocStart[2],
        writesEvidence: evidenceRedirectPattern.test(line),
      };
    }

    const names = expandedPrivateNames(line, privateNames);
    if (names.length === 0) {
      return;
    }
    const writesEvidence =
      evidenceRedirectPattern.test(line) && !logOrSummarySinkPattern.test(line);
    const isOutput =
      outputCommandPattern.test(line) || logOrSummarySinkPattern.test(line);
    const isDiagnostic = diagnosticPattern.test(line);

    for (const name of names) {
      const kind = privateNames.get(name);
      if (kind === "credential") {
        problems.push(
          `${location}: expands ${name}; credentials may only be exported by name for the native tooling.`,
        );
      } else if (isDiagnostic) {
        problems.push(
          `${location}: ${name} appears in a diagnostic, which is copied into the step summary.`,
        );
      } else if (isOutput && !(writesEvidence && kind === "identifier")) {
        problems.push(
          `${location}: ${name} is printed to a log, the step summary, or a non-evidence file.`,
        );
      }
    }
  });
  return problems;
}

function loadScript(relativePath) {
  const fileName = path.basename(relativePath);
  return {
    relativePath,
    contract: scriptContracts[relativePath],
    source: scriptSource(relativePath),
    privateNames: privateNamesFor(relativePath),
    locate: (lineNumber) => `${fileName}:${lineNumber}`,
  };
}

for (const relativePath of Object.keys(scriptContracts)) {
  test(`${relativePath} keeps private values out of diagnostics, logs, and its summary`, () => {
    const script = loadScript(relativePath);
    const classes = new Set(script.privateNames.values());
    if (script.contract.requiresPrivateValues !== false) {
      assert.ok(
        classes.has("identifier") && classes.has("credential"),
        `expected the steps invoking ${relativePath} to pass candidate identifiers and smoke-account credentials, found: ${JSON.stringify(
          Object.fromEntries(script.privateNames),
        )}`,
      );
    }

    const problems = [
      ...analyzeDiagnostics(script),
      ...analyzeSummaryFunction(script),
      ...analyzePrivateValueFlow(script),
    ];
    if (xtracePattern.test(script.source)) {
      problems.push(
        `${relativePath} enables shell tracing, which echoes expanded secret values into the job log.`,
      );
    }
    assertNoProblems(problems, `${relativePath} private value handling:`);
  });
}

// ---------------------------------------------------------------------------
// Behavioral runs with sentinel secrets
// ---------------------------------------------------------------------------

const testRoot = mkdtempSync(
  path.join(tmpdir(), "mobile-release-summary-contract-"),
);
const homeDirectory = path.join(testRoot, "home");
mkdirSync(homeDirectory);
after(() => rmSync(testRoot, { recursive: true, force: true }));

function sentinelFor(name) {
  return `${name.toLowerCase().replaceAll("_", "-")}-secret-sentinel`;
}

/** Sentinel values for every secret-backed variable and non-secret build ID. */
const sentinelEnvironment = Object.fromEntries(
  [...secretBearingEnv.keys(), "NATIVE_SMOKE_BUILD_ID"].map((name) => [
    name,
    sentinelFor(name),
  ]),
);
const identifierNames = new Set(
  [...privateNamesFor(iosGateScript)]
    .filter(([, kind]) => kind === "identifier")
    .map(([name]) => name),
);
identifierNames.add("NATIVE_SMOKE_BUILD_ID");
const readinessWorkflowCommand = "::warning::native-readiness-control-input";
const encodedReadinessWorkflowCommand =
  readinessWorkflowCommand.replaceAll("::", "&#58;&#58;");

function assertNoSentinels(text, description, allowedNames = new Set()) {
  for (const [name, sentinel] of Object.entries(sentinelEnvironment)) {
    if (allowedNames.has(name)) {
      continue;
    }
    assert.ok(
      !text.includes(sentinel),
      `${description} leaks the value of ${name}:\n${text}`,
    );
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeStub(directory, name, body) {
  const stubPath = path.join(directory, name);
  writeFileSync(stubPath, `#!${bashPath}\n${body}\n`);
  chmodSync(stubPath, 0o755);
}

function makeCommandDirectory(name, utilities) {
  const directory = path.join(testRoot, `${name}-bin`);
  mkdirSync(directory);
  for (const utility of utilities) {
    symlinkSync(locateExecutable(utility), path.join(directory, utility));
  }
  return directory;
}

const iosUtilityNames = [
  "awk",
  "bash",
  "cat",
  "date",
  "dirname",
  "find",
  "head",
  "mkdir",
  "sed",
  "tr",
  "wc",
];

function makeIosCommandDirectory(
  name,
  { includeMaestro = true, bootedDevices = null } = {},
) {
  const directory = makeCommandDirectory(name, iosUtilityNames);
  writeStub(directory, "pnpm", "exit 0");
  if (includeMaestro) {
    writeStub(directory, "maestro", "exit 0");
  }
  if (bootedDevices !== null) {
    writeStub(
      directory,
      "xcrun",
      `printf '%s\\n' ${shellQuote(bootedDevices)}`,
    );
  }
  return directory;
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

const brandingValidator = "artifacts/chat-app/scripts/validate-branding.mjs";
const brandingFragmentFile = "native-branding-summary.md";
const brandingReportFile = "native-branding-check.md";

/** Native metadata that matches the approved branding, keyed by platform. */
function approvedNativeMetadata(platform) {
  const { expo } = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "artifacts/chat-app/app.json"),
      "utf8",
    ),
  );
  if (platform === "ios") {
    return {
      CFBundleDisplayName: expo.name,
      CFBundleName: expo.name,
      CFBundleIdentifier: sentinelEnvironment.NATIVE_SMOKE_APP_ID,
      NSCameraUsageDescription: expo.ios.infoPlist.NSCameraUsageDescription,
      NSMicrophoneUsageDescription:
        expo.ios.infoPlist.NSMicrophoneUsageDescription,
    };
  }
  return {
    applicationLabel: expo.name,
    packageName: sentinelEnvironment.NATIVE_SMOKE_APP_ID,
    permissions: expo.android.permissions,
  };
}

/**
 * The workflow's branding step inspects the installed candidate and runs the
 * real branding validator against the same results directory before the
 * summary steps run. The inspected metadata and the detailed report
 * legitimately carry candidate identifiers. Candidate build IDs are
 * non-secret and are copied into the step summary with a fingerprint.
 */
function addBrandingEvidenceFixtures(resultsDir, platform) {
  mkdirSync(resultsDir, { recursive: true });
  const metadataPath = path.join(resultsDir, "native-info.json");
  writeFileSync(
    metadataPath,
    `${JSON.stringify(approvedNativeMetadata(platform), null, 2)}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(workspaceRoot, brandingValidator),
      "--native",
      "--platform",
      platform,
      "--metadata",
      metadataPath,
      "--build-id",
      sentinelEnvironment.NATIVE_SMOKE_BUILD_ID,
      "--results-dir",
      resultsDir,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `${platform}: branding validation of the approved metadata failed\n${result.stdout}${result.stderr}`,
  );
  const report = readFileSync(
    path.join(resultsDir, brandingReportFile),
    "utf8",
  );
  assert.ok(
    report.includes(sentinelEnvironment.NATIVE_SMOKE_BUILD_ID),
    `${platform}: the detailed branding report is uploaded evidence and should record the candidate build ID`,
  );
  const fragment = readFileSync(
    path.join(resultsDir, brandingFragmentFile),
    "utf8",
  );
  assert.ok(
    fragment.includes(sentinelEnvironment.NATIVE_SMOKE_BUILD_ID),
    `${platform}: ${brandingFragmentFile} should show the candidate build ID`,
  );
}

function runGate(name, expectedStatus, commandOptions) {
  const resultsDir = path.join(testRoot, `${name}-results`);
  const summaryPath = path.join(testRoot, `${name}-gate-summary.md`);
  const result = spawnSync(
    bashPath,
    [path.join(workspaceRoot, iosGateScript), "ios"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        PATH: makeIosCommandDirectory(name, commandOptions),
        HOME: homeDirectory,
        ...sentinelEnvironment,
        NATIVE_SMOKE_RESULTS_DIR: resultsDir,
        NATIVE_SMOKE_SUMMARY_DEFER: "1",
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(
    result.status,
    expectedStatus,
    `${name}: expected the gate to exit ${expectedStatus}\n${output}`,
  );
  addBrandingEvidenceFixtures(resultsDir, "ios");
  return { name, resultsDir, summaryPath, output };
}

let gateRuns;
function getGateRuns() {
  gateRuns ??= {
    missingMaestro: runGate("missing-maestro", 2, { includeMaestro: false }),
    wrongModel: runGate("wrong-model", 2, {
      bootedDevices:
        "iPhone 14 (00000000-0000-0000-0000-000000000000) (Booted)",
    }),
    hostileWrongModel: runGate("hostile-wrong-model", 2, {
      bootedDevices: `iPhone 14 ${readinessWorkflowCommand} (00000000-0000-0000-0000-000000000000) (Booted)`,
    }),
    supportedModel: runGate("supported-model", 1, {
      bootedDevices:
        "iPhone SE (3rd generation) (00000000-0000-0000-0000-000000000000) (Booted)",
    }),
  };
  return gateRuns;
}

test("iOS gate keeps private values out of logs and the readiness report while recording candidate IDs in evidence", () => {
  assert.ok(
    identifierNames.has("NATIVE_SMOKE_BUILD_ID"),
    "expected NATIVE_SMOKE_BUILD_ID to be classified as an audited candidate identifier",
  );

  const expectations = {
    missingMaestro: {
      status: "BLOCKED",
      diagnostic: "Required command not found: maestro",
    },
    wrongModel: {
      status: "BLOCKED",
      diagnostic: "Expected iPhone SE (3rd generation); found: iPhone 14",
    },
    hostileWrongModel: {
      status: "BLOCKED",
      diagnostic: `Expected iPhone SE (3rd generation); found: iPhone 14 ${readinessWorkflowCommand}`,
    },
    supportedModel: { status: "READY", diagnostic: null },
  };

  for (const [key, run] of Object.entries(getGateRuns())) {
    const { status, diagnostic } = expectations[key];
    assertNoSentinels(run.output, `${run.name}: gate log output`);
    assert.ok(
      !existsSync(run.summaryPath),
      `${run.name}: the gate must leave GITHUB_STEP_SUMMARY to the workflow when summary writing is deferred`,
    );

    const readinessPath = path.join(run.resultsDir, "ios-readiness.md");
    assert.ok(
      existsSync(readinessPath),
      `${run.name}: missing ios-readiness.md`,
    );
    const readiness = readFileSync(readinessPath, "utf8");
    assert.match(readiness, /^## iOS native large-text readiness$/m);
    assert.ok(
      readiness.includes(`- Status: **${status}**`),
      `${run.name}: readiness report should be ${status}\n${readiness}`,
    );
    if (diagnostic) {
      const readinessDiagnostic = diagnostic.replaceAll(
        "::",
        "&#58;&#58;",
      );
      assert.ok(
        readiness.includes(readinessDiagnostic),
        `${run.name}: readiness report should list the fixed diagnostic\n${readiness}`,
      );
      assert.match(
        readiness,
        new RegExp(
          String.raw`### Blocking prerequisites[\s\S]*\n` +
            String.raw`(` + "```" + String.raw`+)\n` +
            readinessDiagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            String.raw`\n\1`,
        ),
        `${run.name}: readiness diagnostic should be in a literal code block`,
      );
      if (diagnostic.includes(readinessWorkflowCommand)) {
        assert.ok(
          readiness.includes(encodedReadinessWorkflowCommand),
          `${run.name}: readiness report should encode workflow-command sentinels`,
        );
        assert.doesNotMatch(
          readiness,
          /::warning::/,
          `${run.name}: readiness report must not contain a live workflow command`,
        );
      }
    }
    assertNoSentinels(readiness, `${run.name}: ios-readiness.md`);

    for (const file of walkFiles(run.resultsDir)) {
      const relativePath = path.relative(run.resultsDir, file);
      const allowedNames =
        relativePath === "ios-readiness.md" ? new Set() : identifierNames;
      assertNoSentinels(
        readFileSync(file, "utf8"),
        `${run.name}: evidence file ${relativePath}`,
        allowedNames,
      );
    }

    // Audited candidate identifiers stay available to reviewers in evidence.
    assert.equal(
      readFileSync(
        path.join(run.resultsDir, "candidate-build-id.txt"),
        "utf8",
      ).trim(),
      sentinelEnvironment.NATIVE_SMOKE_BUILD_ID,
      `${run.name}: candidate-build-id.txt must record the audited build ID`,
    );
  }

  const runnerMetadata = readFileSync(
    path.join(getGateRuns().supportedModel.resultsDir, "runner-metadata.txt"),
    "utf8",
  );
  assert.ok(
    runnerMetadata.includes(
      `candidate_build_id=${sentinelEnvironment.NATIVE_SMOKE_BUILD_ID}`,
    ),
    `runner-metadata.txt must record the audited build ID\n${runnerMetadata}`,
  );
});

const androidUtilityNames = ["head", "sed", "tail", "timeout", "tr"];

function makeAndroidCommandDirectory(name, { appInstalled }) {
  const directory = makeCommandDirectory(name, androidUtilityNames);
  writeStub(
    directory,
    "uname",
    `case "\${1:-}" in -m) echo x86_64 ;; *) echo Linux ;; esac`,
  );
  for (const tool of [
    "sdkmanager",
    "avdmanager",
    "emulator",
    "aapt2",
    "pnpm",
    "maestro",
  ]) {
    writeStub(directory, tool, "exit 0");
  }
  writeStub(directory, "java", `echo 'openjdk version "17.0.13"' >&2`);
  writeStub(
    directory,
    "adb",
    [
      `case "\${1:-}" in`,
      "  wait-for-device) exit 0 ;;",
      "  get-state) printf 'device\\n' ;;",
      "  shell)",
      `    case "\${2:-}" in`,
      `      wm) if [[ "\${3:-}" == "size" ]]; then printf 'Physical size: 320x568\\n'; else printf 'Physical density: 160\\n'; fi ;;`,
      "      settings) printf '0\\n' ;;",
      `      pm) ${appInstalled ? "printf 'package:/data/app/base.apk\\n'" : "exit 1"} ;;`,
      "      *) exit 1 ;;",
      "    esac ;;",
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
  return directory;
}

function runAndroidPreflight(name, expectedStatus, { appInstalled }) {
  const sdkRoot = path.join(testRoot, `${name}-android-sdk`);
  mkdirSync(sdkRoot);
  const commandDirectory = makeAndroidCommandDirectory(name, { appInstalled });
  const pinnedAapt2 = path.join(
    sdkRoot,
    "build-tools",
    androidBuildToolsVersion,
    "aapt2",
  );
  mkdirSync(path.dirname(pinnedAapt2), { recursive: true });
  symlinkSync(path.join(commandDirectory, "aapt2"), pinnedAapt2);
  const summaryPath = path.join(testRoot, `${name}-preflight-summary.md`);
  const result = spawnSync(
    bashPath,
    [path.join(workspaceRoot, androidPreflightScript)],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        PATH: commandDirectory,
        HOME: homeDirectory,
        ANDROID_SDK_ROOT: sdkRoot,
        GITHUB_STEP_SUMMARY: summaryPath,
        ...sentinelEnvironment,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(
    result.status,
    expectedStatus,
    `${name}: expected the Android preflight to exit ${expectedStatus}\n${output}`,
  );
  assert.ok(
    existsSync(summaryPath),
    `${name}: the Android preflight wrote no step summary`,
  );
  return { name, output, summary: readFileSync(summaryPath, "utf8") };
}

test("Android preflight keeps private values out of its log and step summary", () => {
  const scenarios = [
    {
      name: "android-missing-app",
      appInstalled: false,
      exitStatus: 2,
      status: "BLOCKED",
      marker: "ANDROID_RELEASE_PREFLIGHT=BLOCKED",
      diagnostic:
        "The release-candidate application is not installed on the connected device.",
    },
    {
      name: "android-ready",
      appInstalled: true,
      exitStatus: 0,
      status: "READY",
      marker: "ANDROID_RELEASE_PREFLIGHT=READY",
      diagnostic: null,
    },
  ];

  for (const scenario of scenarios) {
    const run = runAndroidPreflight(scenario.name, scenario.exitStatus, {
      appInstalled: scenario.appInstalled,
    });
    assertNoSentinels(run.output, `${run.name}: preflight log output`);
    assertNoSentinels(run.summary, `${run.name}: preflight step summary`);
    assert.ok(
      run.output.includes(scenario.marker),
      `${run.name}: log should report ${scenario.marker}\n${run.output}`,
    );
    assert.match(run.summary, /^## Android release runner preflight$/m);
    assert.ok(
      run.summary.includes(`- Status: **${scenario.status}**`),
      `${run.name}: summary should report ${scenario.status}\n${run.summary}`,
    );
    if (scenario.diagnostic) {
      for (const [surface, text] of [
        ["log", run.output],
        ["summary", run.summary],
      ]) {
        assert.ok(
          text.includes(
            surface === "summary"
              ? scenario.diagnostic
              : `- ${scenario.diagnostic}`,
          ),
          `${run.name}: ${surface} should carry the fixed diagnostic\n${text}`,
        );
      }
      assert.match(
        run.summary,
        new RegExp(
          String.raw`### Blocking prerequisites[\s\S]*\n` +
            String.raw`(` + "```" + String.raw`+)\n` +
            scenario.diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            String.raw`\n\1`,
        ),
        `${run.name}: summary diagnostic should stay in a literal code block`,
      );
    }
  }
});

function renderSummaryStepEnv(summaryStep, { resultsDir, outcome }) {
  const contextEnv = {
    ...(workflow.env ?? {}),
    ...(summaryStep.job.env ?? {}),
    NATIVE_SMOKE_RESULTS_DIR: resultsDir,
  };
  const placeholders = {
    "github.workspace": workspaceRoot,
    "github.run_id": "1",
    "github.run_number": "1",
    "github.run_attempt": "1",
    "github.repository": "example/chat-app",
    "github.server_url": "https://github.example",
    "github.sha": "0".repeat(40),
    "github.ref": "refs/heads/mobile-v0.0.0",
    "github.ref_name": "mobile-v0.0.0",
    "github.event_name": "workflow_dispatch",
    "runner.temp": testRoot,
  };

  const render = (value, depth = 0) => {
    assert.ok(
      depth < 5,
      `${summaryStep.label}: expression nesting is too deep`,
    );
    return String(value).replace(
      actionExpressionPattern,
      (_, rawExpression) => {
        const expression = rawExpression.trim();
        if (
          /^steps\.[\w-]+\.(outcome|conclusion)$/.test(expression) ||
          /^needs\.[\w-]+\.result$/.test(expression) ||
          expression === "job.status"
        ) {
          return outcome;
        }
        if (
          expression ===
          "inputs.native_smoke_ios_build_id || vars.NATIVE_SMOKE_IOS_BUILD_ID"
        ) {
          return "ios-candidate-build-id";
        }
        if (
          expression ===
          "inputs.native_smoke_android_build_id || vars.NATIVE_SMOKE_ANDROID_BUILD_ID"
        ) {
          return "android-candidate-build-id";
        }
        const envReference = expression.match(/^env\.(\w+)$/);
        if (envReference) {
          assert.ok(
            envReference[1] in contextEnv,
            `${summaryStep.label}: ${expression} is not defined at the workflow or job level`,
          );
          return render(contextEnv[envReference[1]], depth + 1);
        }
        // The static contract already rejects outputs of secret-bearing
        // steps, so any output that reaches a summary step is public data.
        const outputReference = expression.match(
          /^steps\.([\w-]+)\.outputs\.([\w-]+)$/,
        );
        if (outputReference) {
          return `https://github.example/example/chat-app/${outputReference[1]}/${outputReference[2]}`;
        }
        if (expression in placeholders) {
          return placeholders[expression];
        }
        throw new Error(
          `${summaryStep.label}: cannot resolve "${expression}" in this test; add a non-secret placeholder if the reference is legitimate.`,
        );
      },
    );
  };

  return {
    ...Object.fromEntries(
      stringEntries(contextEnv).map(([name, value]) => [name, render(value)]),
    ),
    ...Object.fromEntries(
      stringEntries(summaryStep.step.env).map(([name, value]) => [
        name,
        render(value),
      ]),
    ),
  };
}

function runSummaryStep(summaryStep, { name, resultsDir, outcome }) {
  const scratchName = `${name}-${summaryStep.jobId}-step${summaryStep.index}`;
  const scriptPath = path.join(testRoot, `${scratchName}-summary-step.sh`);
  writeFileSync(scriptPath, summaryStep.step.run);
  const summaryPath = path.join(testRoot, `${scratchName}-github-summary.md`);

  const shell = summaryStep.step.shell ?? "bash";
  assert.equal(
    shell,
    "bash",
    `${summaryStep.label}: this contract test only executes bash summary steps`,
  );
  const shellArguments =
    summaryStep.step.shell === "bash"
      ? ["--noprofile", "--norc", "-eo", "pipefail", scriptPath]
      : ["-e", scriptPath];

  const result = spawnSync(bashPath, shellArguments, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      PATH: [
        makeIosCommandDirectory(`${scratchName}-summary`),
        path.dirname(gitPath),
        process.env.PATH,
      ].join(path.delimiter),
      HOME: homeDirectory,
      GITHUB_STEP_SUMMARY: summaryPath,
      // Even if a secret were ever in scope, the summary must not print it.
      ...sentinelEnvironment,
      ...renderSummaryStepEnv(summaryStep, { resultsDir, outcome }),
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(
    result.status,
    0,
    `${summaryStep.label} (${name}): summary step failed\n${output}`,
  );
  assert.ok(existsSync(summaryPath), `${name}: summary step wrote no summary`);
  return { output, summary: readFileSync(summaryPath, "utf8") };
}

/** Results directories per native job for one summary scenario. */
function scenarioResultsDirs(scenario) {
  const androidResultsDir = path.join(
    testRoot,
    `${scenario.name}-android-results`,
  );
  if (scenario.run) {
    addBrandingEvidenceFixtures(androidResultsDir, "android");
    return {
      "native-ios": scenario.run.resultsDir,
      "native-android": androidResultsDir,
    };
  }
  const iosResultsDir = path.join(testRoot, `${scenario.name}-ios-results`);
  mkdirSync(iosResultsDir);
  mkdirSync(androidResultsDir);
  return { "native-ios": iosResultsDir, "native-android": androidResultsDir };
}

test("workflow summaries show candidate build IDs without exposing private values", () => {
  const runs = getGateRuns();
  const nativeJobs = ["native-ios", "native-android"];
  const nativeSummarySteps = summarySteps.filter(({ jobId }) =>
    nativeJobs.includes(jobId),
  );
  assert.ok(
    nativeSummarySteps.some(({ jobId }) => jobId === "native-ios"),
    "expected the native-ios job to summarize readiness into GITHUB_STEP_SUMMARY",
  );

  const scenarios = [
    {
      name: "blocked",
      run: runs.wrongModel,
      outcome: "failure",
      status: "BLOCKED",
      diagnostic: "Expected iPhone SE (3rd generation); found: iPhone 14",
    },
    {
      name: "blocked-readiness-sentinel",
      run: runs.hostileWrongModel,
      outcome: "failure",
      status: "BLOCKED",
      diagnostic: `Expected iPhone SE (3rd generation); found: iPhone 14 ${readinessWorkflowCommand}`,
    },
    {
      name: "ready",
      run: runs.supportedModel,
      outcome: "success",
      status: "READY",
      diagnostic: null,
    },
    {
      // Nothing was written before the summary steps ran (for example the
      // candidate was never installed), so every fallback branch executes.
      name: "missing-evidence",
      run: null,
      outcome: "failure",
      status: "BLOCKED",
      diagnostic: null,
    },
  ];

  for (const scenario of scenarios) {
    const resultsDirs = scenarioResultsDirs(scenario);
    const summariesByJob = Object.fromEntries(
      nativeJobs.map((jobId) => [jobId, ""]),
    );

    for (const summaryStep of nativeSummarySteps) {
      const { output, summary } = runSummaryStep(summaryStep, {
        name: scenario.name,
        resultsDir: resultsDirs[summaryStep.jobId],
        outcome: scenario.outcome,
      });
      assertNoSentinels(
        output,
        `${summaryStep.label} (${scenario.name}): log output`,
      );
      assertNoSentinels(
        summary,
        `${summaryStep.label} (${scenario.name}): step summary`,
        new Set(["NATIVE_SMOKE_BUILD_ID"]),
      );
      assert.ok(
        !summary.includes("__NATIVE_BRANDING_REPORT_URL__"),
        `${summaryStep.label} (${scenario.name}): left the report URL placeholder unrendered\n${summary}`,
      );
      summariesByJob[summaryStep.jobId] += summary;
    }

    const iosSummary = summariesByJob["native-ios"];
    assert.match(iosSummary, /^## iOS native large-text readiness$/m);
    assert.ok(
      iosSummary.includes(`- Status: **${scenario.status}**`),
      `${scenario.name}: iOS summary should report ${scenario.status}\n${iosSummary}`,
    );
    if (scenario.diagnostic) {
      const summaryDiagnostic = scenario.diagnostic.replaceAll(
        "::",
        "&#58;&#58;",
      );
      assert.ok(
        iosSummary.includes(summaryDiagnostic),
        `${scenario.name}: iOS summary should surface the fixed readiness diagnostic\n${iosSummary}`,
      );
      assert.match(
        iosSummary,
        new RegExp(
          String.raw`### Readiness diagnostics[\s\S]*\n` +
            String.raw`(` + "```" + String.raw`+)\n` +
            summaryDiagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            String.raw`\n\1`,
        ),
        `${scenario.name}: readiness diagnostic should stay in a literal code block`,
      );
      if (scenario.diagnostic.includes(readinessWorkflowCommand)) {
        assert.ok(
          iosSummary.includes(encodedReadinessWorkflowCommand),
          `${scenario.name}: iOS summary should contain the encoded workflow-command sentinel`,
        );
        assert.doesNotMatch(
          iosSummary,
          /::warning::/,
          `${scenario.name}: iOS summary must not contain a live workflow command`,
        );
      }
    }
    // Both the copied fragment and the fallback branch must have produced the
    // branding section, otherwise the no-sentinel checks above were vacuous.
    for (const [jobId, heading] of [
      ["native-ios", "## iOS native branding"],
      ["native-android", "## Android native branding"],
    ]) {
      assert.ok(
        summariesByJob[jobId].includes(heading),
        `${scenario.name}: ${jobId} summary should include "${heading}"\n${summariesByJob[jobId]}`,
      );
    }
  }
});

test("native branding summaries keep a durable report snapshot after artifact removal", () => {
  const summaryStep = summarySteps.find(
    ({ jobId, step }) =>
      jobId === "native-ios" && step.name === "Summarize iOS native branding",
  );
  assert.ok(summaryStep, "the iOS native branding summary step must exist");

  const resultsDir = path.join(testRoot, "durable-branding-snapshot");
  addBrandingEvidenceFixtures(resultsDir, "ios");
  const { summary } = runSummaryStep(summaryStep, {
    name: "durable-branding-snapshot",
    resultsDir,
    outcome: "success",
  });

  assert.match(
    summary,
    /Archived report snapshot: \[available in this summary\]\(#archived-native-branding-report-snapshot\)/,
    "the native summary must expose a durable in-summary report location",
  );
  assert.match(
    summary,
    /### Archived native branding report snapshot[\s\S]*Candidate build fingerprint \(SHA-256\)/,
    "the durable snapshot must contain the bounded branding result",
  );
  assert.match(
    summary,
    /Detailed report: preserved in this release summary; the artifact copy is linked above while retained\./,
    "the durable snapshot must not depend on the artifact link",
  );

  // Historical step summaries are immutable after publication. Removing the
  // source fixture models the later artifact-retention expiry boundary.
  rmSync(resultsDir, { recursive: true, force: true });
  assert.match(
    summary,
    /### Archived native branding report snapshot[\s\S]*Candidate build fingerprint \(SHA-256\)/,
    "the already-published summary must remain reviewable after artifact removal",
  );
});

test("native evidence summaries link only the fixed uploaded report", () => {
  const evidenceRoot = path.join(testRoot, "evidence-link-safety");
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(path.join(evidenceRoot, "ios", "20260909T120000Z"), {
    recursive: true,
  });
  mkdirSync(path.join(evidenceRoot, "android", "20260909T120000Z"), {
    recursive: true,
  });
  writeFileSync(
    path.join(evidenceRoot, "arbitrary-evidence.txt"),
    "private-evidence-marker [attacker](https://attacker.example/report)\n",
  );
  const rawEvidenceText =
    "::error::raw-evidence [unsafe](https://attacker.example/raw)";
  writeFileSync(
    path.join(evidenceRoot, "ios", "20260909T120000Z", "pass-fail-record.txt"),
    `status=PASS\n${rawEvidenceText}=first\n${rawEvidenceText}=second\n`,
  );
  const summaryPath = path.join(testRoot, "evidence-link-safety-summary.md");
  const iosArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/456";
  const androidArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/789";
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: androidArtifactUrl,
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "the intentionally incomplete evidence root should remain blocked after the wrapped check",
  );

  const summary = readFileSync(summaryPath, "utf8");
  const commandGuard = result.stdout.match(
    /^::stop-commands::([0-9a-f-]+)\n[\s\S]*\n::([0-9a-f-]+)::\n?$/,
  );
  assert.ok(
    commandGuard,
    "a failed native check must leave its output inside the workflow command guard",
  );
  assert.equal(
    commandGuard?.[1],
    commandGuard?.[2],
    "the workflow command guard must restore parsing with the same stop token",
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp(rawEvidenceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "raw evidence text must not reach the workflow log or become a workflow command",
  );
  assert.match(
    summary,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${iosArtifactUrl.replaceAll(
        ".",
        "\\.",
      )}\)`,
    ),
    "the iOS section should link the uploaded artifact page using the fixed report name",
  );
  assert.match(
    summary,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${androidArtifactUrl.replaceAll(
        ".",
        "\\.",
      )}\)`,
    ),
    "the Android section should link the uploaded artifact page using the fixed report name",
  );
  assert.match(
    summary,
    /## iOS native large-text evidence[\s\S]*- Status: \*\*FAIL\*\*[\s\S]*### Blocking evidence findings/,
    "a failed native check must preserve a sanitized blocking summary",
  );

  const unsafeAndroidSummaryPath = path.join(
    testRoot,
    "evidence-link-safety-unsafe-android-summary.md",
  );
  const unsafeResult = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: unsafeAndroidSummaryPath,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL:
          "https://attacker.example/report.md)](https://attacker.example/second",
      },
    },
  );
  assert.notEqual(
    unsafeResult.status,
    0,
    "the intentionally incomplete evidence root should remain blocked with an unsafe Android URL",
  );

  const unsafeSummary = readFileSync(unsafeAndroidSummaryPath, "utf8");
  assert.match(
    unsafeSummary,
    /## Android native large-text evidence[\s\S]*Detailed evidence report: \*\*Unavailable\*\*/,
    "an unsafe artifact URL must not become an Android Markdown link",
  );
  assert.doesNotMatch(
    unsafeSummary,
    /private-evidence-marker|attacker\.example|arbitrary-evidence/,
    "evidence contents and identifiers must not become summary link targets",
  );
});

test("empty platform artifact downloads preserve the other platform report", () => {
  const evidenceRoot = path.join(testRoot, "empty-platform-download");
  const androidRunDir = path.join(evidenceRoot, "android", "20260909T120000Z");
  mkdirSync(androidRunDir, { recursive: true });
  writeFileSync(
    path.join(androidRunDir, brandingReportFile),
    "# Native branding validation\n\n- Status: **PASS**\n",
  );

  const summaryPath = path.join(
    testRoot,
    "empty-platform-download-summary.md",
  );
  const iosArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/456";
  const androidArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/789";
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: androidArtifactUrl,
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: "",
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: "success",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "an explicitly empty platform artifact download result must keep the release blocked",
  );

  const summary = readFileSync(summaryPath, "utf8");
  const iosSection = summary.match(
    /## iOS native large-text evidence[\s\S]*?(?=## Android native large-text evidence)/,
  )?.[0];
  const androidSection = summary.match(
    /## Android native large-text evidence[\s\S]*/,
  )?.[0];
  assert.ok(iosSection, "the summary should include the empty-result iOS section");
  assert.ok(
    androidSection,
    "the summary should include the successful Android section",
  );
  assert.match(iosSection, /- Status: \*\*FAIL\*\*/);
  assert.match(iosSection, /- Artifact download: \*\*FAIL\*\*/);
  assert.match(
    iosSection,
    /native evidence artifact download did not complete/,
  );
  assert.ok(
    iosSection.includes(iosRecoveryLine),
    "the empty iOS download result must include the shared fixed recovery action",
  );
  assert.match(iosSection, /- Detailed evidence report: \*\*Unavailable\*\*/);
  assert.doesNotMatch(
    iosSection,
    new RegExp(iosArtifactUrl.replaceAll(".", "\\.")),
    "the empty-result platform must not link an unavailable download",
  );
  assert.match(androidSection, /- Artifact download: \*\*PASS\*\*/);
  assert.match(
    androidSection,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${androidArtifactUrl.replaceAll(
        ".",
        "\\.",
      )}\)`,
    ),
    "the available platform report link must survive the other download failure",
  );
  assert.doesNotMatch(
    summary,
    /::|attacker\.example/,
    "download diagnostics must not introduce workflow commands or unsafe summary text",
  );
});

test("both empty platform artifact downloads include fixed recovery actions", () => {
  const evidenceRoot = path.join(testRoot, "both-empty-platform-download");
  mkdirSync(evidenceRoot, { recursive: true });

  const summaryPath = path.join(
    testRoot,
    "both-empty-platform-download-summary.md",
  );
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: "",
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: "",
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL:
          "https://github.example/example/chat-app/actions/runs/123/artifacts/456",
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL:
          "https://github.example/example/chat-app/actions/runs/123/artifacts/789",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "both explicitly empty platform artifact download results must keep the release blocked",
  );

  const summary = readFileSync(summaryPath, "utf8");
  const iosSection = summary.match(
    /## iOS native large-text evidence[\s\S]*?(?=## Android native large-text evidence)/,
  )?.[0];
  const androidSection = summary.match(
    /## Android native large-text evidence[\s\S]*/,
  )?.[0];
  assert.ok(iosSection, "the summary should include the empty-result iOS section");
  assert.ok(
    androidSection,
    "the summary should include the empty-result Android section",
  );
  assert.match(iosSection, /- Status: \*\*FAIL\*\*/);
  assert.match(iosSection, /- Artifact download: \*\*FAIL\*\*/);
  assert.ok(
    iosSection.includes(iosRecoveryLine),
    "the empty iOS download result must include the shared fixed recovery action",
  );
  assert.match(androidSection, /- Status: \*\*FAIL\*\*/);
  assert.match(androidSection, /- Artifact download: \*\*FAIL\*\*/);
  assert.ok(
    androidSection.includes(androidRecoveryLine),
    "the empty Android download result must include the shared fixed recovery action",
  );
  assert.doesNotMatch(
    summary,
    /github\.example|::|attacker\.example/,
    "both empty downloads must not expose artifact URLs or unsafe summary text",
  );
});

test("unsafe download metadata cannot alter fixed platform recovery actions", () => {
  const evidenceRoot = path.join(testRoot, "unsafe-download-metadata");
  mkdirSync(evidenceRoot, { recursive: true });

  const summaryPath = path.join(
    testRoot,
    "unsafe-download-metadata-summary.md",
  );
  const shellMarkerPath = path.join(
    testRoot,
    "unsafe-download-metadata-shell-marker",
  );
  const iosDownloadResult = `failure; touch "${shellMarkerPath}" [iOS](https://attacker.example/ios)\n::error::ios`;
  const androidDownloadResult = `$(touch "${shellMarkerPath}") [Android](https://attacker.example/android)\n\`::warning::\``;
  const iosArtifactUrl = `https://github.example/example/chat-app/actions/runs/123/artifacts/456)](https://attacker.example/second)\n::error::$(touch "${shellMarkerPath}")`;
  const androidArtifactUrl =
    "https://attacker.example/report.md)](https://attacker.example/second);echo android";
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: iosDownloadResult,
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: androidDownloadResult,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: androidArtifactUrl,
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "unsafe download outcomes must still block the release",
  );
  assert.equal(
    existsSync(shellMarkerPath),
    false,
    "download metadata must never be evaluated as shell commands",
  );

  const commandGuard = result.stdout.match(
    /^::stop-commands::([0-9a-f-]+)\n[\s\S]*\n::([0-9a-f-]+)::\n?$/,
  );
  assert.ok(
    commandGuard,
    "a failed native check must leave its output inside the workflow command guard",
  );
  assert.equal(
    commandGuard?.[1],
    commandGuard?.[2],
    "the workflow command guard must restore parsing with the same stop token",
  );
  for (const [streamName, stream] of [
    ["stdout", result.stdout],
    ["stderr", result.stderr],
  ]) {
    for (const unsafeValue of [
      iosDownloadResult,
      androidDownloadResult,
      iosArtifactUrl,
      androidArtifactUrl,
    ]) {
      assert.equal(
        stream.includes(unsafeValue),
        false,
        `unsafe download metadata must not reach checker ${streamName}`,
      );
    }
  }
  assert.match(
    result.stdout,
    /Checking native large-text evidence under /,
    "the checker must preserve its fixed stdout context",
  );
  assert.match(
    result.stderr,
    /\[ios\] The iOS native evidence artifact download did not complete\./,
    "the checker must preserve the fixed iOS download failure context",
  );
  assert.match(
    result.stderr,
    /\[android\] The Android native evidence artifact download did not complete\./,
    "the checker must preserve the fixed Android download failure context",
  );
  assert.match(
    result.stderr,
    /Native large-text evidence completeness check FAILED with \d+ issue\(s\)\./,
    "the checker must preserve its fixed failure context",
  );
  assert.match(
    result.stderr,
    /Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts\./,
    "the checker must preserve the release-blocking failure context",
  );

  const summary = readFileSync(summaryPath, "utf8");
  const recoveryLines = summary
    .split("\n")
    .filter((line) => line.startsWith("- Recovery:"));
  assert.deepEqual(
    recoveryLines,
    nativeRecoveryLines,
    "both platform recovery instructions must come from the shared fixed contract",
  );
  assert.match(
    summary,
    /## iOS native large-text evidence[\s\S]*- Status: \*\*FAIL\*\*[\s\S]*- Artifact download: \*\*FAIL\*\*/,
    "unsafe iOS download metadata must remain a fixed blocking failure",
  );
  assert.match(
    summary,
    /## Android native large-text evidence[\s\S]*- Status: \*\*FAIL\*\*[\s\S]*- Artifact download: \*\*FAIL\*\*/,
    "unsafe Android download metadata must remain a fixed blocking failure",
  );
  for (const unsafeValue of [
    iosDownloadResult,
    androidDownloadResult,
    iosArtifactUrl,
    androidArtifactUrl,
  ]) {
    assert.equal(
      summary.includes(unsafeValue),
      false,
      "unsafe download metadata must not reach the reviewer-facing summary",
    );
  }
  assert.doesNotMatch(
    summary,
    /attacker\.example|::error::|::warning::|unsafe-download-metadata-shell-marker/,
    "unsafe shell and Markdown control text must stay out of the recovery summary",
  );
});

test("successful downloads cannot turn unsafe artifact URLs into report links", () => {
  const summaryPath = path.join(
    testRoot,
    "unsafe-successful-download-summary.md",
  );
  const result = spawnSync(
    bashPath,
    [
      path.join(
        workspaceRoot,
        "scripts/tests/native-evidence-summary-regression-fixture.sh",
      ),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        REVIEWED_REF: "refs/heads/fixture",
        NATIVE_EVIDENCE_HOSTILE_SUCCESS_METADATA: "1",
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `successful hostile-download fixture should pass its fixed release checks\n${result.stdout}${result.stderr}`,
  );

  const summary = readFileSync(summaryPath, "utf8");
  for (const platform of ["iOS", "Android"]) {
    const section = summary.match(
      new RegExp(
        `## ${platform} native large-text evidence[\\s\\S]*?(?=## (?:Android|$) native large-text evidence|$)`,
      ),
    )?.[0];
    assert.ok(section, `the summary should include the ${platform} section`);
    assert.match(section, /- Status: \*\*PASS\*\*/);
    assert.match(section, /- Artifact download: \*\*PASS\*\*/);
    assert.match(
      section,
      /- Detailed evidence report: \*\*Unavailable\*\*/,
      `${platform} must not receive a report link for an unsafe URL`,
    );
    assert.doesNotMatch(
      section,
      /- Detailed evidence report: \[[^\]]+\]\(/,
      `${platform} must not emit any Markdown report link`,
    );
  }

  for (const [streamName, stream] of [
    ["stdout", result.stdout],
    ["stderr", result.stderr],
    ["summary", summary],
  ]) {
    assert.doesNotMatch(
      stream,
      /https?:\/\/|attacker\.example|::error::|::warning::|unsafe-download-metadata-shell-marker/,
      `hostile URLs and control text must not reach ${streamName}`,
    );
  }
  assert.match(
    result.stdout,
    /Native large-text evidence completeness check passed for iOS and Android\./,
    "the checker must retain its fixed successful status",
  );
});

test("cleanup-gated skipped retries preserve fixed blocking summaries", () => {
  const evidenceRoot = path.join(testRoot, "cleanup-failure-stale-output");
  const iosRunDir = path.join(evidenceRoot, "ios", "stale-run");
  const androidRunDir = path.join(evidenceRoot, "android", "stale-run");
  const staleEvidenceMarkers = {
    ios: "private-ios-evidence-marker",
    android: "private-android-evidence-marker",
  };
  for (const [platform, runDir] of Object.entries({
    ios: iosRunDir,
    android: androidRunDir,
  })) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, brandingReportFile),
      `${staleEvidenceMarkers[platform]} must not appear in the release summary\n`,
    );
  }
  const summaryPath = path.join(
    testRoot,
    "cleanup-failure-stale-output-summary.md",
  );
  const iosArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/456";
  const androidArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/789";

  const result = spawnSync(
    bashPath,
    [path.join(workspaceRoot, nativeEvidenceCheckerScript), evidenceRoot],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: androidArtifactUrl,
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: "skipped",
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: "skipped",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "a cleanup failure that skips the retry must keep the release blocked",
  );

  const summary = readFileSync(summaryPath, "utf8");
  for (const [platform, label, recoveryLine] of [
    ["ios", "iOS", iosRecoveryLine],
    ["android", "Android", androidRecoveryLine],
  ]) {
    const section = summary.match(
      new RegExp(`## ${label} native large-text evidence[\\s\\S]*?(?=## |$)`),
    )?.[0];
    assert.ok(
      section,
      `${platform}: the cleanup-failure summary must include its platform section`,
    );
    assert.match(
      section,
      /- Status: \*\*FAIL\*\*[\s\S]*- Artifact download: \*\*FAIL\*\*/,
      `${platform}: the affected platform must retain a fixed blocking summary`,
    );
    assert.match(
      section,
      new RegExp(recoveryLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${platform}: the affected platform must retain fixed recovery guidance`,
    );
  }
  for (const value of [
    ...Object.values(staleEvidenceMarkers),
    iosArtifactUrl,
    androidArtifactUrl,
  ]) {
    assert.equal(
      summary.includes(value),
      false,
      "stale evidence text and artifact metadata must not reach the summary",
    );
  }
});

test("partial native reruns keep each platform linked to its own artifact", () => {
  const artifactNames = {
    ios: "native-large-text-ios",
    android: "native-large-text-android",
  };
  const nativeJobs = {
    ios: workflow.jobs["native-ios"],
    android: workflow.jobs["native-android"],
  };
  for (const [platform, job] of Object.entries(nativeJobs)) {
    const upload = job.steps.find(
      (step) => step.id === `upload-${platform}-native-smoke`,
    );
    assert.equal(
      upload?.with?.name,
      artifactNames[platform],
      `${platform}: the native job must upload its stable artifact name`,
    );
    assert.equal(
      upload?.with?.overwrite,
      true,
      `${platform}: a partial rerun must replace only its stable artifact`,
    );
  }

  const runId = 123;
  const initialAttempt = 1;
  const partialRerunAttempt = 2;
  const initialArtifacts = {
    ios: {
      name: artifactNames.ios,
      runId,
      runAttempt: initialAttempt,
      artifactId: 456,
    },
    android: {
      name: artifactNames.android,
      runId,
      runAttempt: initialAttempt,
      artifactId: 789,
    },
  };
  const rerunArtifacts = {
    ios: {
      name: artifactNames.ios,
      runId,
      runAttempt: partialRerunAttempt,
      artifactId: 999,
    },
    // A partial rerun keeps the successful Android job output and artifact.
    android: initialArtifacts.android,
  };

  function artifactUrl(artifact) {
    return `https://github.example/example/chat-app/actions/runs/${artifact.runId}/artifacts/${artifact.artifactId}`;
  }

  function materializeDownloadedArtifacts(name, artifacts) {
    const downloadedRoot = path.join(
      testRoot,
      `${name}-downloaded-native-artifacts`,
    );
    for (const platform of ["ios", "android"]) {
      const artifact = artifacts[platform];
      const runDir = path.join(
        downloadedRoot,
        platform,
        `${artifact.runId}-${artifact.runAttempt}`,
      );
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, brandingReportFile),
        [
          "# Native branding validation",
          "",
          "- Status: **PASS**",
          `- Platform: ${platform}`,
          `- Artifact name: ${artifact.name}`,
          `- Run attempt: ${artifact.runAttempt}`,
          "",
        ].join("\n"),
      );
    }
    return downloadedRoot;
  }

  const evidenceStep = workflow.jobs["mobile-release-gate"].steps.find(
    (step) => step.name === "Validate native evidence completeness",
  );
  const nativeJobOutputs = {};
  for (const [platform, job] of Object.entries(nativeJobs)) {
    const outputExpression = job.outputs.native_evidence_artifact_url;
    const outputMatch = String(outputExpression).match(
      /^\$\{\{\s*steps\.([^\s.]+)\.outputs\.artifact-url\s*\}\}$/,
    );
    assert.ok(
      outputMatch,
      `${platform}: the native job output must come from its upload step`,
    );
    assert.equal(
      outputMatch[1],
      `upload-${platform}-native-smoke`,
      `${platform}: the native job output must use its own upload step`,
    );
    nativeJobOutputs[`native-${platform}`] = {
      native_evidence_artifact_url: artifactUrl(rerunArtifacts[platform]),
    };
  }
  function resolveNeedsOutput(expression) {
    const match = String(expression).match(
      /^\$\{\{\s*needs\.([^\s.]+)\.outputs\.([^\s.]+)\s*\}\}$/,
    );
    assert.ok(match, `unsupported workflow output expression: ${expression}`);
    return nativeJobOutputs[match[1]][match[2]];
  }

  const finalGateArtifactUrls = {
    ios: resolveNeedsOutput(evidenceStep.env.NATIVE_IOS_EVIDENCE_ARTIFACT_URL),
    android: resolveNeedsOutput(
      evidenceStep.env.NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL,
    ),
  };
  assert.equal(
    finalGateArtifactUrls.ios,
    artifactUrl(rerunArtifacts.ios),
    "the final gate must receive the replacement iOS upload output",
  );
  assert.equal(
    finalGateArtifactUrls.android,
    artifactUrl(rerunArtifacts.android),
    "the final gate must retain the successful Android upload output",
  );

  const gateDownloads = workflow.jobs["mobile-release-gate"].steps.filter(
    (step) =>
      step.uses === pinnedDownloadArtifactAction &&
      step.id?.startsWith("download"),
  );
  assert.deepEqual(
    gateDownloads.map((step) => step.with.name).sort(),
    [artifactNames.android, artifactNames.ios].sort(),
    "the final gate must download both stable platform artifact names",
  );

  const cleanupScenarios = [
    {
      jobId: "mobile-release-gate",
      initialStepId: "download",
      retryStepId: "retry",
      cleanupNameSuffix: "before retry",
    },
    {
      jobId: "mobile-publish",
      initialStepId: "download-publish",
      retryStepId: "retry-publish",
      cleanupNameSuffix: "before publishing retry",
    },
  ];
  for (const {
    jobId,
    initialStepId,
    retryStepId,
    cleanupNameSuffix,
  } of cleanupScenarios) {
    const job = workflow.jobs[jobId];
    for (const platform of ["ios", "android"]) {
      const initialStep = job.steps.find(
        (step) => step.id === `${initialStepId}-${platform}-native-smoke`,
      );
      const retryStep = job.steps.find(
        (step) => step.id === `${retryStepId}-${platform}-native-smoke`,
      );
      const cleanupStep = job.steps.find(
        (step) =>
          step.name ===
          `Clear partial ${platform === "ios" ? "iOS" : "Android"} native smoke artifacts ${cleanupNameSuffix}`,
      );
      const platformPath = `test-results/native-large-text/${platform}`;

      assert.ok(initialStep, `${jobId}: ${platform} initial download is required`);
      assert.ok(retryStep, `${jobId}: ${platform} retry download is required`);
      assert.ok(
        cleanupStep,
        `${jobId}: ${platform} retry must clear partial output first`,
      );
      assert.equal(
        cleanupStep.if,
        `\${{ always() && steps.${initialStep.id}.outcome != 'success' }}`,
        `${jobId}: ${platform} cleanup must run only after an unsuccessful initial download`,
      );
      assert.equal(
        cleanupStep.run,
        `rm -rf -- ${platformPath} && mkdir -p -- ${platformPath}`,
        `${jobId}: ${platform} cleanup must recreate the download directory`,
      );
      assert.equal(
        cleanupStep["continue-on-error"],
        true,
        `${jobId}: ${platform} cleanup failure must still reach evidence validation`,
      );
      assert.ok(
        cleanupStep.id,
        `${jobId}: ${platform} cleanup must have an outcome that gates retry`,
      );
      assert.equal(
        retryStep.if,
        `\${{ always() && steps.${initialStep.id}.outcome != 'success' && steps.${cleanupStep.id}.outcome == 'success' }}`,
        `${jobId}: ${platform} retry must run only after cleanup succeeds`,
      );
      assert.equal(
        retryStep.with.path,
        platformPath,
        `${jobId}: ${platform} retry must extract into the recreated platform directory`,
      );

      const partialRoot = mkdtempSync(
        path.join(tmpdir(), `native-partial-${jobId}-${platform}-`),
      );
      const partialPath = path.join(partialRoot, platformPath);
      mkdirSync(partialPath, { recursive: true });
      const privateMarker = path.join(partialPath, "stale-private-evidence.txt");
      writeFileSync(privateMarker, "private evidence must not survive retry");
      const cleanupResult = spawnSync(
        bashPath,
        ["-c", cleanupStep.run.replaceAll(platformPath, partialPath)],
        { cwd: workspaceRoot, encoding: "utf8" },
      );
      assert.equal(
        cleanupResult.status,
        0,
        `${jobId}: ${platform} partial-output cleanup should succeed`,
      );
      assert.deepEqual(
        readdirSync(partialPath),
        [],
        `${jobId}: ${platform} retry directory must not retain partial files`,
      );
      rmSync(partialRoot, { recursive: true, force: true });
    }
  }

  for (const [jobId, checkerStepName] of [
    ["mobile-release-gate", "Validate native evidence completeness"],
    ["mobile-publish", "Require approved iOS and Android evidence"],
  ]) {
    const checkerStep = workflow.jobs[jobId].steps.find(
      (step) => step.name === checkerStepName,
    );
    assert.ok(
      checkerStep,
      `${jobId}: evidence validation must remain present after cleanup failure`,
    );
    assert.match(
      checkerStep.env.NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT,
      /steps\.retry(?:-publish)?-ios-native-smoke\.outcome/,
      `${jobId}: iOS validation must receive the skipped retry outcome after cleanup failure`,
    );
    assert.match(
      checkerStep.env.NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT,
      /steps\.retry(?:-publish)?-android-native-smoke\.outcome/,
      `${jobId}: Android validation must receive the skipped retry outcome after cleanup failure`,
    );
  }

  function runEvidenceSummary(name, artifacts, urls) {
    const downloadedRoot = materializeDownloadedArtifacts(name, artifacts);
    const summaryPath = path.join(testRoot, `${name}-summary.md`);
    const result = spawnSync(
      bashPath,
      [path.join(workspaceRoot, nativeEvidenceCheckerScript), downloadedRoot],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          NATIVE_IOS_EVIDENCE_ARTIFACT_URL: urls.ios,
          NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: urls.android,
        },
      },
    );
    assert.notEqual(
      result.status,
      0,
      `${name}: incomplete fixture should remain blocked`,
    );
    const summary = readFileSync(summaryPath, "utf8");
    assertNoSentinels(summary, `${name}: step summary`);
    return summary;
  }

  const initialSummary = runEvidenceSummary(
    "partial-rerun-before",
    initialArtifacts,
    {
      ios: artifactUrl(initialArtifacts.ios),
      android: artifactUrl(initialArtifacts.android),
    },
  );
  assert.match(
    initialSummary,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${artifactUrl(
        initialArtifacts.ios,
      ).replaceAll(".", "\\.")}\)`,
    ),
    "the initial iOS job output should link its uploaded artifact",
  );
  assert.match(
    initialSummary,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${artifactUrl(
        initialArtifacts.android,
      ).replaceAll(".", "\\.")}\)`,
    ),
    "the initial Android job output should link its uploaded artifact",
  );
  assert.notDeepEqual(
    rerunArtifacts.ios,
    initialArtifacts.ios,
    "the partial rerun must replace the iOS artifact record",
  );
  assert.deepEqual(
    rerunArtifacts.android,
    initialArtifacts.android,
    "the partial rerun must retain the Android artifact record",
  );

  const rerunSummary = runEvidenceSummary(
    "partial-rerun-after",
    rerunArtifacts,
    finalGateArtifactUrls,
  );

  const iosSection = rerunSummary.match(
    /## iOS native large-text evidence[\s\S]*?(?=## Android native large-text evidence)/,
  )?.[0];
  const androidSection = rerunSummary.match(
    /## Android native large-text evidence[\s\S]*/,
  )?.[0];
  assert.ok(iosSection, "the rerun summary should include the iOS section");
  assert.ok(
    androidSection,
    "the rerun summary should include the Android section",
  );
  assert.match(
    iosSection,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${artifactUrl(
        rerunArtifacts.ios,
      ).replaceAll(".", "\\.")}\)`,
    ),
    "the iOS summary link should open the replacement iOS artifact",
  );
  assert.doesNotMatch(
    iosSection,
    new RegExp(artifactUrl(rerunArtifacts.android).replaceAll(".", "\\.")),
    "the iOS summary must not link the retained Android artifact",
  );
  assert.match(
    androidSection,
    new RegExp(
      String.raw`\[native-branding-check\.md\]\(${artifactUrl(
        rerunArtifacts.android,
      ).replaceAll(".", "\\.")}\)`,
    ),
    "the Android summary link should remain on the retained Android artifact",
  );
  assert.doesNotMatch(
    androidSection,
    new RegExp(artifactUrl(rerunArtifacts.ios).replaceAll(".", "\\.")),
    "the Android summary must not link the replacement iOS artifact",
  );
  assert.doesNotMatch(
    rerunSummary,
    new RegExp(artifactUrl(initialArtifacts.ios).replaceAll(".", "\\.")),
    "the rerun summary must not retain the replaced iOS artifact URL",
  );
  assert.match(rerunSummary, /\[native-branding-check\.md\]\(/g);
  assert.equal(
    [...rerunSummary.matchAll(/\[native-branding-check\.md\]\(/g)].length,
    2,
    "the rerun summary should record exactly one fixed report link per platform",
  );
});

test("native reports use a durable redacted archive before artifact expiry", () => {
  const gate = workflow.jobs["mobile-release-gate"];
  assert.deepEqual(
    gate.permissions,
    { contents: "write" },
    "the archive job must have only the repository permission needed for release assets",
  );

  const prepareStep = gate.steps.find(
    (step) => step.id === "prepare-native-archive",
  );
  const createStep = gate.steps.find(
    (step) => step.id === "create-native-archive",
  );
  const iosUploadStep = gate.steps.find(
    (step) => step.id === "upload-ios-native-archive",
  );
  const androidUploadStep = gate.steps.find(
    (step) => step.id === "upload-android-native-archive",
  );
  const evidenceStep = gate.steps.find(
    (step) => step.id === "evidence-completeness",
  );
  assert.match(
    prepareStep?.run ?? "",
    new RegExp(nativeReleaseArchiveScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the release gate must prepare reports through the redacting archive boundary",
  );
  assert.equal(
    createStep?.env?.GH_TOKEN,
    "${{ github.token }}",
    "only the release-asset creation step may receive the GitHub write token",
  );
  assert.equal(
    iosUploadStep?.env?.GH_TOKEN,
    "${{ github.token }}",
    "the iOS release-asset upload must use the GitHub write token",
  );
  assert.equal(
    androidUploadStep?.env?.GH_TOKEN,
    "${{ github.token }}",
    "the Android release-asset upload must use the GitHub write token",
  );
  assert.match(
    evidenceStep?.env?.NATIVE_IOS_EVIDENCE_ARCHIVE_URL ?? "",
    /releases\/download\/native-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\/native-release-report-ios\.md/,
    "the iOS summary must receive its deterministic durable archive location",
  );
  assert.match(
    evidenceStep?.env?.NATIVE_ANDROID_EVIDENCE_ARCHIVE_URL ?? "",
    /releases\/download\/native-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\/native-release-report-android\.md/,
    "the Android summary must receive its deterministic durable archive location",
  );

  const archiveRoot = mkdtempSync(path.join(testRoot, "native-report-archive-"));
  const fixtureBuilderPath = path.join(
    workspaceRoot,
    "scripts/tests/native-large-text-evidence-fixture.sh",
  );
  const buildId = "private-candidate-build-id";
  const fixtureResult = spawnSync(
    bashPath,
    [
      "-c",
      'source "$1"; write_native_large_text_evidence_fixture "$2" ios "$3"',
      "native-report-archive-fixture",
      fixtureBuilderPath,
      archiveRoot,
      buildId,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(fixtureResult.status, 0, fixtureResult.stderr);

  const outputPath = path.join(archiveRoot, "native-release-report-ios.md");
  const archiveResult = spawnSync(
    bashPath,
    [path.join(workspaceRoot, nativeReleaseArchiveScript), "ios", archiveRoot, outputPath],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(archiveResult.status, 0, archiveResult.stderr);
  const archivedReport = readFileSync(outputPath, "utf8");
  assert.match(archivedReport, /- Platform: \*\*ios\*\*/);
  assert.match(archivedReport, /- Status: \*\*PASS\*\*/);
  assert.doesNotMatch(
    archivedReport,
    /private-candidate-build-id|Candidate build ID|fingerprint|account|password|token|secret|credential/i,
    "the durable archive must exclude candidate and private source values",
  );

  rmSync(archiveRoot, { recursive: true, force: true });
});

test("archive failures block native evidence without publishing dead locations", () => {
  for (const platform of ["ios", "android"]) {
    const upload = workflow.jobs[`native-${platform}`].steps.find(
      (step) => step.id === `upload-${platform}-native-smoke`,
    );
    assert.equal(
      upload?.with?.["retention-days"],
      90,
      `${platform}: native report artifacts must use the maximum bounded retention window`,
    );
  }

  const evidenceRoot = path.join(testRoot, "failed-native-report-archive");
  const summaryPath = path.join(
    testRoot,
    "failed-native-report-archive-summary.md",
  );
  const iosArchiveUrl =
    "https://github.example/example/chat-app/releases/download/native-evidence-123-1/native-release-report-ios.md";
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_ARCHIVE_URL: iosArchiveUrl,
        NATIVE_IOS_EVIDENCE_ARCHIVE_RESULT: "failure",
        NATIVE_ANDROID_EVIDENCE_ARCHIVE_RESULT: "skipped",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "a failed durable archive must keep native release evidence blocked",
  );
  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /- Durable archive: \*\*FAIL\*\*/);
  assert.match(summary, /- Durable evidence report: \*\*Unavailable\*\*/);
  assert.doesNotMatch(
    summary,
    new RegExp(iosArchiveUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "a failed archive must not publish its dead release-asset location",
  );
});

test("expired native report artifacts are detected before a report link is published", () => {
  for (const platform of ["ios", "android"]) {
    const upload = workflow.jobs[`native-${platform}`].steps.find(
      (step) => step.id === `upload-${platform}-native-smoke`,
    );
    assert.equal(
      upload?.with?.["retention-days"],
      90,
      `${platform}: native report artifacts must use the maximum bounded retention window`,
    );
  }

  const evidenceRoot = path.join(testRoot, "expired-native-report");
  for (const platform of ["ios", "android"]) {
    const runDir = path.join(evidenceRoot, platform, "expired-run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, brandingReportFile),
      "# Native branding validation\n\n- Status: **PASS**\n",
    );
  }

  const summaryPath = path.join(
    testRoot,
    "expired-native-report-summary.md",
  );
  const iosArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/456";
  const androidArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/789";
  const result = spawnSync(
    bashPath,
    [
      path.join(workspaceRoot, untrustedCheckerWrapperScript),
      bashPath,
      path.join(workspaceRoot, nativeEvidenceCheckerScript),
      evidenceRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_IOS_EVIDENCE_ARTIFACT_URL: iosArtifactUrl,
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL: androidArtifactUrl,
        // GitHub reports an expired artifact as a failed download.
        NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT: "failure",
        NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT: "failure",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "expired native report artifacts must keep release review blocked",
  );

  const summary = readFileSync(summaryPath, "utf8");
  assert.match(
    summary,
    /- Artifact link check: \*\*EXPIRED OR UNAVAILABLE\*\*/,
    "an expired artifact must be identified as unavailable instead of linked",
  );
  assert.match(
    summary,
    /artifact may have expired/,
    "the summary must tell reviewers that expiry is one possible cause",
  );
  assert.doesNotMatch(
    summary,
    /github\.example|actions\/runs\/123\/artifacts\/(?:456|789)/,
    "an expired artifact URL must not remain in the release summary",
  );
});

test("native evidence checker output is isolated from workflow commands", () => {
  const wrapperCall = `bash ${untrustedCheckerWrapperScript}`;
  const checkerCall = `bash ${nativeEvidenceCheckerScript}`;
  const checkerCallers = listSteps().filter(({ step }) =>
    String(step.run ?? "").includes(checkerCall),
  );
  const wrappedCheckerCallers = checkerCallers.filter(({ step }) =>
    String(step.run ?? "").includes(wrapperCall),
  );

  assert.equal(
    checkerCallers.length,
    11,
    "every native evidence checker caller must be inventoried by this contract",
  );
  assert.equal(
    wrappedCheckerCallers.length,
    checkerCallers.length,
    "every native evidence checker caller must use the shared untrusted-checker wrapper",
  );
  for (const { label, step } of wrappedCheckerCallers) {
    const normalizedRun = step.run.replace(/\s+/g, " ").trim();
    assert.match(
      normalizedRun,
      new RegExp(
        `${wrapperCall.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${checkerCall.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`,
      ),
      `${label} must invoke the shared wrapper with the native evidence checker`,
    );
  }

  const wrapperSource = readFileSync(
    path.join(workspaceRoot, untrustedCheckerWrapperScript),
    "utf8",
  );
  assert.match(
    wrapperSource,
    /stop_token="\$\(node -e 'process\.stdout\.write\(require\("node:crypto"\)\.randomUUID\(\)\)'\\?\)"/,
    "the shared wrapper must generate an unpredictable stop token with cryptographic randomness",
  );
  assert.doesNotMatch(
    wrapperSource,
    /stop_token=.*GITHUB_RUN_(?:ID|ATTEMPT)/,
    "the shared wrapper must not derive its stop token from predictable run metadata",
  );
  assert.match(
    wrapperSource,
    /echo "::stop-commands::\$\{stop_token\}"/,
    "the shared wrapper must disable workflow-command parsing before checker output",
  );
  assert.match(
    wrapperSource,
    /set \+e[\s\S]*"\$@"[\s\S]*checker_status=\$\?[\s\S]*set -e/,
    "the shared wrapper must capture the checker status without a transforming pipeline",
  );
  assert.match(
    wrapperSource,
    /echo "::\$\{stop_token\}::"/,
    "the shared wrapper must restore workflow-command parsing after checker output",
  );
  assert.match(
    wrapperSource,
    /exit "\$checker_status"/,
    "the shared wrapper must preserve the checker result",
  );

  const probePath = path.join(testRoot, "untrusted-checker-probe.sh");
  writeFileSync(
    probePath,
    '#!/usr/bin/env bash\nprintf "%s\\n" "::warning::untrusted checker output"\nexit 37\n',
  );
  chmodSync(probePath, 0o755);
  const result = spawnSync(
    bashPath,
    [path.join(workspaceRoot, untrustedCheckerWrapperScript), probePath],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    37,
    "the wrapper must preserve the checker exit status",
  );
  assert.match(
    result.stdout,
    /::stop-commands::[0-9a-f-]+\n::warning::untrusted checker output\n::[0-9a-f-]+::/,
    "the wrapper must keep checker output visible between the command-boundary markers",
  );
});

test("release summary writers encode workflow-command sentinels", () => {
  const sentinel = "::error::summary-control-input";
  const safetyProbe = spawnSync(
    bashPath,
    [
      "-c",
      'source "$1"; sanitize_workflow_text "$2"',
      "workflow-output-safety",
      path.join(workspaceRoot, workflowOutputSafetyScript),
      sentinel,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(safetyProbe.status, 0, safetyProbe.stderr);
  assert.equal(
    safetyProbe.stdout,
    "&#58;&#58;error&#58;&#58;summary-control-input",
  );
  assert.doesNotMatch(safetyProbe.stdout, /::error::/);

  const resultsDir = path.join(testRoot, "workflow-command-sentinel-results");
  const summaryPath = path.join(
    testRoot,
    "workflow-command-sentinel-summary.md",
  );
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    path.join(resultsDir, "native-branding-summary.md"),
    [
      "## iOS native branding",
      "",
      `- Native label: ${sentinel}`,
      "- Detailed report: [report](__NATIVE_BRANDING_REPORT_URL__)",
      "",
    ].join("\n"),
  );

  const brandingResult = spawnSync(
    bashPath,
    [path.join(workspaceRoot, nativeBrandingSummaryScript), "ios"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        NATIVE_SMOKE_RESULTS_DIR: resultsDir,
        NATIVE_BRANDING_ARTIFACT_URL: "https://github.example/artifact",
      },
    },
  );
  assert.equal(brandingResult.status, 0, brandingResult.stderr);
  const summary = readFileSync(summaryPath, "utf8");
  assert.doesNotMatch(summary, /::error::/);
  assert.match(summary, /&#58;&#58;error&#58;&#58;summary-control-input/);
});

test("release summary writers keep hostile diagnostics literal and line-broken", () => {
  const hostileDiagnostic = [
    "# reviewer-controlled heading",
    "- reviewer-controlled bullet",
    "`reviewer-controlled code` | reviewer-controlled pipe",
    "",
    "reviewer-controlled continuation",
  ].join("\n");
  const rendererProbe = spawnSync(
    bashPath,
    [
      "-c",
      'source "$1"; printf "%s\\n" "$2" | render_markdown_code_block',
      "workflow-output-safety",
      path.join(workspaceRoot, workflowOutputSafetyScript),
      hostileDiagnostic,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(rendererProbe.status, 0, rendererProbe.stderr);
  assert.equal(
    rendererProbe.stdout,
    `\`\`\`\n${hostileDiagnostic}\n\`\`\`\n`,
    "the shared renderer must preserve Markdown-looking diagnostics as code",
  );

  const androidPreviewStep = listSteps().find(
    ({ jobId, step }) =>
      jobId === "android-preview-evidence" &&
      step.name === "Validate changed Android preview records",
  );
  assert.match(
    androidPreviewStep?.step.run ?? "",
    /safe_reasons[\s\S]*render_markdown_code_block/,
    "Android preview reasons must use the literal renderer",
  );

  const iosReadinessStep = summarySteps.find(
    ({ jobId, step }) =>
      jobId === "native-ios" && step.name === "Summarize iOS readiness",
  );
  assert.ok(iosReadinessStep, "the iOS readiness summary step must exist");
  const readinessResultsDir = path.join(
    testRoot,
    "hostile-ios-readiness-summary-results",
  );
  mkdirSync(readinessResultsDir, { recursive: true });
  writeFileSync(
    path.join(readinessResultsDir, "ios-readiness.md"),
    [
      "## iOS native large-text readiness",
      "",
      "### Blocking prerequisites",
      hostileDiagnostic,
      "",
      "### Later fixed section",
      "- fixed content",
      "",
    ].join("\n"),
  );
  const { summary: readinessSummary } = runSummaryStep(iosReadinessStep, {
    name: "hostile-ios-readiness",
    resultsDir: readinessResultsDir,
    outcome: "failure",
  });
  assert.match(
    readinessSummary,
    new RegExp(
      String.raw`### Readiness diagnostics[\s\S]*\n` +
        String.raw`(` + "```" + String.raw`+)\n` +
        hostileDiagnostic
          .split("\n")
          .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\n") +
        String.raw`\n\1`,
    ),
    "iOS readiness diagnostics must remain one literal multi-line block",
  );

  const brandingStep = summarySteps.find(
    ({ jobId, step }) =>
      jobId === "native-ios" && step.name === "Summarize iOS native branding",
  );
  assert.ok(brandingStep, "the iOS branding summary step must exist");
  const brandingResultsDir = path.join(
    testRoot,
    "hostile-native-branding-summary-results",
  );
  mkdirSync(brandingResultsDir, { recursive: true });
  writeFileSync(
    path.join(brandingResultsDir, "native-branding-summary.md"),
    [
      "## iOS native branding",
      "",
      hostileDiagnostic,
      "",
      "- Detailed report: [native-branding-check.md](__NATIVE_BRANDING_REPORT_URL__)",
      "",
    ].join("\n"),
  );
  const { summary: brandingSummary } = runSummaryStep(brandingStep, {
    name: "hostile-native-branding",
    resultsDir: brandingResultsDir,
    outcome: "success",
  });
  assert.match(
    brandingSummary,
    /## iOS native branding[\s\S]*### Branding validation details[\s\S]*```[\s\S]*# reviewer-controlled heading[\s\S]*reviewer-controlled continuation[\s\S]*```/,
    "native branding report content must be copied as literal text",
  );
  assert.match(
    brandingSummary,
    /- Detailed report: \[native-branding-check\.md\]\(https:\/\/github\.example\/example\/chat-app\/upload-ios-native-smoke\/artifact-url\)/,
    "the fixed branding report link must remain outside the literal report block",
  );

  for (const relativePath of [
    iosPreflightScript,
    androidPreflightScript,
    "artifacts/chat-app/e2e/native-large-text/run.sh",
    nativeBrandingSummaryScript,
  ]) {
    assert.match(
      scriptSource(relativePath),
      /render_markdown_code_block/,
      `${relativePath} must use the shared literal renderer`,
    );
  }
});

test("hosted native evidence summaries record the checked revision before untrusted checks", () => {
  const checkerCall = `bash ${nativeEvidenceCheckerScript}`;
  const checkerCallers = listSteps().filter(({ step }) =>
    String(step.run ?? "").includes(checkerCall),
  );
  const summaryCheckerCallers = checkerCallers.filter(
    ({ step }) => !String(step.run ?? "").includes("--check-collection-size"),
  );

  assert.equal(
    summaryCheckerCallers.length,
    9,
    "every hosted native evidence summary caller must be covered",
  );

  for (const { label, step } of summaryCheckerCallers) {
    assert.equal(
      step.env?.REVIEWED_REF,
      "${{ github.ref }}",
      `${label} must use the trusted workflow ref for revision metadata`,
    );

    const run = String(step.run);
    const revisionMetadataIndex = run.indexOf(
      'echo "## Reviewed release revision"',
    );
    const checkerIndex = run.indexOf(checkerCall);
    assert.ok(
      revisionMetadataIndex >= 0 && revisionMetadataIndex < checkerIndex,
      `${label} must write trusted revision metadata before the checker can fail`,
    );
    assert.match(
      run,
      /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"/,
      `${label} must resolve the checked commit from the checkout`,
    );
    assert.match(run, /Checked ref: `%s`/);
    assert.match(run, /Resolved commit SHA: `%s`/);
    assert.doesNotMatch(
      run,
      /summary_path.*(?:REVIEWED_REF|resolved_commit_sha)|(?:REVIEWED_REF|resolved_commit_sha).*summary_path/,
      `${label} must not derive revision metadata from checker output`,
    );
  }
});

test("non-native release summaries record the checked revision without private inputs", () => {
  const summaryCases = [
    ["mobile-release-node-range", "Reject invalid Node range before release checks"],
    ["android-preview-evidence", "Validate changed Android preview records"],
    ["ios-preview-evidence", "Validate changed iOS preview records"],
    ["native-ios", "Summarize iOS readiness"],
    ["native-ios", "Summarize iOS native branding"],
    ["native-android", "Summarize Android native branding"],
    ["idle-profile-registration", "Summarize idle-profile registration check"],
  ];

  for (const [jobId, stepName] of summaryCases) {
    const job = workflow.jobs[jobId];
    assert.ok(job, `${jobId} must exist`);
    const step = job.steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `${jobId} must define "${stepName}"`);
    assert.equal(
      step.env.REVIEWED_REF,
      "${{ github.ref }}",
      `${jobId} ${stepName} must use the trusted workflow ref`,
    );

    const run = String(step.run);
    const revisionMetadataIndex = run.indexOf(
      'echo "## Reviewed release revision"',
    );
    assert.ok(
      revisionMetadataIndex >= 0,
      `${jobId} ${stepName} must write revision metadata`,
    );
    assert.match(
      run,
      /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"/,
      `${jobId} ${stepName} must resolve the checked commit from the checkout`,
    );
    assert.match(run, /Checked ref: `%s`/);
    assert.match(run, /Resolved commit SHA: `%s`/);
    assert.doesNotMatch(
      run,
      /secrets\.|E2E_CHAT_URL|E2E_API_URL|CLERK_SECRET_KEY|DATABASE_URL|NATIVE_SMOKE_APP_ID|NATIVE_SMOKE_EMAIL|NATIVE_SMOKE_PASSWORD/,
      `${jobId} ${stepName} must not expose secrets or private release inputs`,
    );

    const summaryWriteIndex = run.indexOf('>> "$GITHUB_STEP_SUMMARY"');
    assert.ok(
      summaryWriteIndex < 0 || revisionMetadataIndex < summaryWriteIndex,
      `${jobId} ${stepName} must write revision metadata before its summary`,
    );
    if (stepName.includes("branding")) {
      assert.ok(
        revisionMetadataIndex < run.indexOf("scripts/summarize-native-branding.sh"),
        `${jobId} ${stepName} must write revision metadata before branding output`,
      );
    }
  }
});
