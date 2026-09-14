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
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
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

const iosGateScript = "artifacts/chat-app/e2e/native-large-text/run.sh";
const androidPreflightScript = "scripts/check-android-release-prerequisites.sh";
const nativeEvidenceCheckerScript =
  "scripts/check-native-large-text-evidence.sh";

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
  "scripts/check-native-large-text-evidence.sh": {
    diagnosticFunction: "record_summary_issue",
    diagnosticVariableAllowlist: ["platform"],
    summaryFunction: "write_evidence_summary",
    evidenceDirectoryVariable: null,
    requiresPrivateValues: false,
  },
};

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
const summarySteps = allSteps.filter(
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
 * references and `pnpm --filter <package> <script>` invocations up to three
 * levels deep.
 */
function discoverInvokedScripts() {
  const packages = workspacePackages();
  const discovered = new Map();
  const visited = new Set();
  const queue = allSteps
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

    if (depth >= 3) {
      continue;
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

test("idle-profile registration check blocks release and reports its result", () => {
  const idleJob = workflow.jobs["idle-profile-registration"];
  assert.ok(idleJob, "release workflow must define the idle-profile job");

  const preflightStep = idleJob.steps.find(
    (step) => step.name === "Verify idle-profile browser targets",
  );
  assert.ok(preflightStep, "idle-profile job must preflight its browser targets");
  assert.equal(preflightStep.env.E2E_CHAT_URL, "${{ secrets.E2E_CHAT_URL }}");
  assert.equal(preflightStep.env.E2E_API_URL, "${{ secrets.E2E_API_URL }}");
  assert.match(
    preflightStep.run,
    /check_target "Chat App" "\$E2E_CHAT_URL"/,
    "preflight must identify and check the configured Chat App target",
  );
  assert.match(
    preflightStep.run,
    /check_target "API" "\$\{E2E_API_URL%\/\}\/api\/healthz"/,
    "preflight must check the API public health route",
  );
  assert.match(preflightStep.run, /--connect-timeout 5/);
  assert.match(preflightStep.run, /--max-time 10/);
  assert.match(
    preflightStep.run,
    /\$\{label\} target is unavailable or unhealthy\./,
    "preflight failures must clearly identify the unavailable target",
  );
  assert.doesNotMatch(
    preflightStep.run,
    /echo[^\n]*(?:E2E_CHAT_URL|E2E_API_URL|"\$url")/,
    "preflight diagnostics must not print configured target URLs",
  );

  const runStep = idleJob.steps.find(
    (step) => step.name === "Run idle-profile registration release check",
  );
  assert.ok(runStep, "idle-profile job must run the browser check");
  assert.ok(
    idleJob.steps.indexOf(preflightStep) < idleJob.steps.indexOf(runStep),
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
  assert.equal(uploadStep.uses, "actions/upload-artifact@v4");
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
  assert.match(summaryStep.run, /## Idle profile registration/);
  assert.match(summaryStep.run, /Status: \*\*PASS\*\*/);
  assert.match(summaryStep.run, /Status: \*\*FAIL\*\*/);

  const gate = workflow.jobs["mobile-release-gate"];
  assert.ok(
    gate.needs.includes("idle-profile-registration"),
    "the final release gate must require the idle-profile job",
  );
  const blockingStep = gate.steps.find(
    (step) => step.name === "Block release unless both native checks pass",
  );
  assert.equal(
    blockingStep.env.IDLE_PROFILE_RESULT,
    "${{ needs.idle-profile-registration.result }}",
  );
  assert.match(
    blockingStep.run,
    /\$IDLE_PROFILE_RESULT" != "success"/,
    "the final gate must reject a failed idle-profile job",
  );
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
      (step) => step[`uses`] === "actions/upload-artifact@v4",
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
      (step) => step[`uses`] === "actions/download-artifact@v4",
    );
    assert.deepEqual(
      downloads.map((step) => step.with.name).sort(),
      ["native-large-text-android", "native-large-text-ios"],
      `${jobId} must support mixed-attempt artifacts after a partial rerun`,
    );
  }

  const publishSteps = workflow.jobs["mobile-publish"].steps;
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
  assert.ok(
    publishSteps[approvalIndex].run.includes(
      'if [[ "$approved_build_id" != "$tested_build_id" ]]',
    ),
    "publish approval intake must match approval and evidence candidate IDs",
  );
  assert.ok(
    publishSteps[approvalIndex].run.includes(
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
    "the workflow needs read-only Actions access to verify environment reviews",
  );
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
    /^needs\.[\w-]+\.result$/.test(trimmed) ||
    /^needs\.[\w-]+\.outputs\.[\w-]+$/.test(trimmed) ||
    trimmed === "job.status" ||
    /^(?:github\.(?!token\b)[\w.-]+|runner\.\w+|inputs\.[\w-]+)$/.test(trimmed) ||
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
      assert.ok(
        readiness.includes(`- ${diagnostic}`),
        `${run.name}: readiness report should list the fixed diagnostic\n${readiness}`,
      );
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
  const summaryPath = path.join(testRoot, `${name}-preflight-summary.md`);
  const result = spawnSync(
    bashPath,
    [path.join(workspaceRoot, androidPreflightScript)],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        PATH: makeAndroidCommandDirectory(name, { appInstalled }),
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
          text.includes(`- ${scenario.diagnostic}`),
          `${run.name}: ${surface} should carry the fixed diagnostic\n${text}`,
        );
      }
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
      PATH: makeIosCommandDirectory(`${scratchName}-summary`),
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
      assert.ok(
        iosSummary.includes(`- ${scenario.diagnostic}`),
        `${scenario.name}: iOS summary should surface the fixed readiness diagnostic\n${iosSummary}`,
      );
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
  const summaryPath = path.join(testRoot, "evidence-link-safety-summary.md");
  const iosArtifactUrl =
    "https://github.example/example/chat-app/actions/runs/123/artifacts/456";
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
        NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL:
          "https://attacker.example/report.md)](https://attacker.example/second",
      },
    },
  );
  assert.notEqual(
    result.status,
    0,
    "the intentionally incomplete evidence root should remain blocked",
  );

  const summary = readFileSync(summaryPath, "utf8");
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
    /## Android native large-text evidence[\s\S]*Detailed evidence report: \*\*Unavailable\*\*/,
    "an unsafe artifact URL must not become an Android Markdown link",
  );
  assert.doesNotMatch(
    summary,
    /private-evidence-marker|attacker\.example|arbitrary-evidence/,
    "evidence contents and identifiers must not become summary link targets",
  );
});

test("native evidence checker output is isolated from workflow commands", () => {
  const evidenceSteps = [
    workflow.jobs["mobile-release-gate"].steps.find(
      (step) => step.name === "Validate native evidence completeness",
    ),
    workflow.jobs["mobile-publish"].steps.find(
      (step) => step.name === "Require approved iOS and Android evidence",
    ),
  ];

  for (const step of evidenceSteps) {
    assert.ok(step, "expected both native evidence workflow steps");
    assert.match(
      step.run,
      /echo "::stop-commands::\$\{stop_token\}"/,
      `${step.name} must disable workflow-command parsing before checker output`,
    );
    assert.match(
      step.run,
      /stop_token="\$\(node -e 'process\.stdout\.write\(require\("node:crypto"\)\.randomUUID\(\)\)'\\?\)"/,
      `${step.name} must generate an unpredictable stop token with cryptographic randomness`,
    );
    assert.doesNotMatch(
      step.run,
      /stop_token=.*GITHUB_RUN_(?:ID|ATTEMPT)/,
      `${step.name} must not derive its stop token from predictable run metadata`,
    );
    assert.match(
      step.run,
      /bash scripts\/check-native-large-text-evidence\.sh/,
      `${step.name} must preserve the checker as the diagnostic source`,
    );
    assert.match(
      step.run,
      /checker_status=\$\?/,
      `${step.name} must capture the checker status without a transforming pipeline`,
    );
    assert.match(
      step.run,
      /echo "::\$\{stop_token\}::"/,
      `${step.name} must restore workflow-command parsing after checker output`,
    );
    assert.match(
      step.run,
      /exit "\$checker_status"/,
      `${step.name} must preserve the checker result`,
    );
  }
});
