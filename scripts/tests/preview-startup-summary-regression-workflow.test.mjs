import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/preview-startup-summary-regression.yml",
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const workflowText = readFileSync(workflowPath, "utf8");
const validatorPath = path.join(
  workspaceRoot,
  "artifacts/chat-app/scripts/validate-preview-startup.mjs",
);

function extractWorkflowHereDoc(variableName) {
  const match = workflowText.match(
    new RegExp(
      `cat > "\\$${variableName}" <<'EOF'\\n([\\s\\S]*?)\\n\\s*EOF`,
    ),
  );
  assert.ok(match, `workflow is missing the ${variableName} here-doc`);
  const body = match[1];
  const indents = body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const sharedIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return (
    body
      .split("\n")
      .map((line) => line.slice(sharedIndent))
      .join("\n") + "\n\n"
  );
}

function runValidator(env) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-workflow-"),
  );
  const summaryPath = path.join(temporaryDirectory, "summary.md");
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...env },
    encoding: "utf8",
  });

  try {
    const summary = existsSync(summaryPath)
      ? readFileSync(summaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runWorkflowVerificationStep() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-step-"),
  );
  const scriptPath = path.join(temporaryDirectory, "verify-hosted-summary.sh");
  const githubStepSummaryPath = path.join(temporaryDirectory, "summary.md");
  const verificationStep = workflow.jobs["verify-hosted-summary"].steps.find(
    (step) =>
      step.name === "Verify healthy and failing preview startup summaries",
  );
  assert.equal(
    typeof verificationStep?.run,
    "string",
    "hosted preview summary workflow must retain its verification script",
  );
  writeFileSync(scriptPath, verificationStep.run);

  const result = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", ". \"$1\"", "bash", scriptPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: githubStepSummaryPath,
        REVIEWED_REF: "preview-startup-summary-regression-test-ref",
      },
      encoding: "utf8",
    },
  );

  try {
    const summary = existsSync(githubStepSummaryPath)
      ? readFileSync(githubStepSummaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("hosted preview startup summary regression checks the reviewed revision", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/preview-startup-summary-regression.yml",
    ".github/workflows/preview-startup-real-platform.yml",
    ".replit",
    "artifacts/chat-app/package.json",
    "artifacts/chat-app/scripts/refresh-preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-shared.mjs",
    "artifacts/chat-app/scripts/preview-launch-evidence.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.test.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup-runtime-diagnostic.test.mjs",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.type, "string");
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const jobs = Object.entries(workflow.jobs);
  assert.deepEqual(
    jobs.map(([jobId]) => jobId),
    ["verify-hosted-summary", "measure-preview-timing"],
  );
  const [, job] = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);

  assert.equal(
    job.steps[1].uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(job.steps[1].with.version, "10.26.1");
  assert.equal(job.steps[2].uses, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  assert.equal(job.steps[2].with["node-version"], 24);
  assert.equal(job.steps[2].with.cache, "pnpm");
  assert.equal(job.steps[3].run, "pnpm install --frozen-lockfile");

  const verification = job.steps[4].run;
  assert.deepEqual(job.steps[4].env, {
    REVIEWED_REF:
      "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  });
  assert.match(
    verification,
    /node artifacts\/chat-app\/scripts\/validate-preview-startup\.mjs\s+\\\s*\n\s+--log-file/,
  );
  assert.match(
    verification,
    /PREVIEW_PUBLIC_URL=https:\/\/preview\.example\.test\/expo\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(
    verification,
    /REPLIT_EXPO_DEV_DOMAIN=fallback-preview\.example\.test\s+\\\s*\n\s+PREVIEW_PUBLIC_URL=https:\/\/preview\.example\.test\/expo\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(verification, /Expo preview startup output is healthy:/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=handoff-server-stall-manifest/,
  );
  assert.match(
    verification,
    /manifest response headers received but body did not complete/,
  );
  assert.match(
    verification,
    /250ms configured local handoff deadline/,
  );
  assert.match(
    verification,
    /The hosted Metro body-stall summary did not retain safe failure and recovery guidance/,
  );
  assert.match(verification, /bounded missing-library diagnosis/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=unexpected-startup-failure/,
  );
  assert.match(
    verification,
    /The hosted unexpected-startup summary exposed raw output or lost its bounded diagnosis/,
  );
  assert.match(
    verification,
    /Preview startup could not be confirmed\. See the workflow log for details\./,
  );
  assert.match(verification, /expected_library_identifier="libgtk-3\.so\.0"/);
  assert.match(
    verification,
    /expected_failure_summary_path="\$\(mktemp\)"/,
  );
  assert.match(
    verification,
    /cmp -s "\$failure_summary_path" "\$expected_failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_library_identifier" "\$failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_diagnosis" "\$GITHUB_STEP_SUMMARY"/,
  );
  assert.match(
    verification,
    /published hosted summary exposed raw child-process output or private material/,
  );
  assert.match(verification, /private material/);
  assert.match(
    verification,
    /diagnosis_matches="\$\(grep -E -- '\^\\\*\\\*Diagnosis:\\\*\\\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools:/,
  );
  assert.match(
    verification,
    /\.\*\\\(missing runtime library: \.\*libgtk-3\\\.so\\\.0\\\)\[\[:space:\]\]\*\$' "\$summary_path" \|\| true\)"/,
  );
  assert.match(verification, /diagnosis_line="\$diagnosis_matches"/);
  assert.match(verification, /printf '%s\\n' "\$diagnosis_line"/);
  assert.match(
    verification,
    /contained output beyond the bounded diagnosis/,
  );
  const staleBaselineIndex = verification.indexOf(
    "PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION=0.0.0",
  );
  const healthyValidationIndex = verification.indexOf(
    "printf 'Starting Metro Bundler\\n' > \"$healthy_log\"",
  );
  assert.ok(
    staleBaselineIndex >= 0 && staleBaselineIndex < healthyValidationIndex,
    "the stale-tooling baseline must run before the healthy captured-log check",
  );
  const staleSummaryPublishIndex = verification.indexOf(
    'cat "$tooling_summary_path"',
  );
  const malformedSettingIndex = verification.indexOf(
    "malformed_preview_setting=",
  );
  assert.ok(
    staleSummaryPublishIndex >= 0 &&
      staleSummaryPublishIndex < malformedSettingIndex &&
      verification.includes('>> "$GITHUB_STEP_SUMMARY"'),
    "stale-tooling guidance must reach the real workflow summary before later checks",
  );
  assert.match(verification, /malformed_preview_setting/);
  assert.match(
    verification,
    /malformed preview-setting diagnosis/,
  );
  assert.match(
    verification,
    /malformed preview-setting summary contained private material/,
  );
  assert.match(verification, /base64 --decode/);
  assert.match(verification, /"\$GITHUB_STEP_SUMMARY"/);
  const revisionMetadataIndex = verification.indexOf(
    'echo "## Reviewed preview startup revision"',
  );
  const publishedSummaryIndex = verification.indexOf(
    'echo "## Preview startup summary regression"',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < publishedSummaryIndex,
    "the hosted preview summary must publish revision metadata before its result sections",
  );
  assert.match(
    verification,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*safe_reviewed_ref="\$\(sanitize_workflow_text "\$REVIEWED_REF"\)/,
  );
  assert.doesNotMatch(
    verification,
    /secrets\.|EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL|cat "\$healthy_log"/,
    "the hosted preview revision summary must not expose secrets or raw logs",
  );
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL/);
});

test("hosted preview timing evidence covers every supported runner profile", () => {
  const timingJob = workflow.jobs["measure-preview-timing"];
  assert.equal(timingJob["runs-on"], "${{ matrix.os }}");
  assert.equal(timingJob["timeout-minutes"], 30);
  assert.deepEqual(timingJob.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  const timingStep = timingJob.steps.at(-1);
  assert.equal(timingStep.name, "Measure startup, public preview, and local handoff phases");
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_LAUNCHER=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_HANDOFF=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_SKIP_PUBLIC=1/);
  assert.match(timingStep.run, /REPLIT_EXPO_SESSION_SECRET=/);
  assert.match(timingStep.run, /PREVIEW_TIMING_OUTPUT="\$timing_path"/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /PREVIEW_HANDOFF_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /preview-startup-timing\/v1/);
  assert.match(timingStep.run, /timing\.maxTimeoutMs !== 300000/);
  assert.match(timingStep.run, /evidence\.elapsedMs >= budgetMs/);
  assert.match(timingStep.run, /publicPreview\.status !== "NOT_ASSESSED"/);
  assert.doesNotMatch(timingStep.run, /PREVIEW_STARTUP_TEST_FIXTURE|preview-timing\.test/);
});

test("hosted preview startup checks remain read-only", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});

test("hosted preview startup workflow summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-long-path",
  });
  const lines = result.summary.split("\n");

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(lines.length, 7, `${result.stdout}${result.stderr}`);
  assert.equal(lines[0], "### Expo preview startup");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "**Status:** FAIL");
  assert.equal(lines[3], "");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "");
  assert.match(
    lines[4],
    /^\*\*Diagnosis:\*\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools: error while loading shared libraries: [^\r\n]*\(missing runtime library: [^\r\n]*libgtk-3\.so\.0\)[ \t]*$/,
  );
});

test("hosted preview startup workflow invalid-setting summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_PUBLIC_URL: "https://[preview-setting-secret",
    PREVIEW_PUBLIC_TIMEOUT_MS: "25",
    PREVIEW_STARTUP_TIMEOUT_MS: "2000",
    PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(
    result.summary,
    extractWorkflowHereDoc("expected_setting_summary_path"),
  );
});

test("hosted preview startup workflow step succeeds end-to-end", () => {
  const result = runWorkflowVerificationStep();

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.summary, /## Reviewed preview startup revision/);
  assert.match(result.summary, /## Preview startup summary regression/);
  assert.match(
    result.summary,
    /Healthy captured startup: \*\*PASS\*\* \(success output retained; no failure section\)/,
  );
  assert.match(
    result.summary,
    /Malformed preview setting: \*\*PASS\*\* \(configuration diagnosis retained; private material excluded\)/,
  );
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/preview-startup-summary-regression.yml",
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const workflowText = readFileSync(workflowPath, "utf8");
const validatorPath = path.join(
  workspaceRoot,
  "artifacts/chat-app/scripts/validate-preview-startup.mjs",
);

function extractWorkflowHereDoc(variableName) {
  const match = workflowText.match(
    new RegExp(
      `cat > "\\$${variableName}" <<'EOF'\\n([\\s\\S]*?)\\n\\s*EOF`,
    ),
  );
  assert.ok(match, `workflow is missing the ${variableName} here-doc`);
  const body = match[1];
  const indents = body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const sharedIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return (
    body
      .split("\n")
      .map((line) => line.slice(sharedIndent))
      .join("\n") + "\n\n"
  );
}

function runValidator(env) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-workflow-"),
  );
  const summaryPath = path.join(temporaryDirectory, "summary.md");
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...env },
    encoding: "utf8",
  });

  try {
    const summary = existsSync(summaryPath)
      ? readFileSync(summaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runWorkflowVerificationStep() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-step-"),
  );
  const scriptPath = path.join(temporaryDirectory, "verify-hosted-summary.sh");
  const githubStepSummaryPath = path.join(temporaryDirectory, "summary.md");
  const verificationStep = workflow.jobs["verify-hosted-summary"].steps.find(
    (step) =>
      step.name === "Verify healthy and failing preview startup summaries",
  );
  assert.equal(
    typeof verificationStep?.run,
    "string",
    "hosted preview summary workflow must retain its verification script",
  );
  writeFileSync(scriptPath, verificationStep.run);

  const result = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", ". \"$1\"", "bash", scriptPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: githubStepSummaryPath,
        REVIEWED_REF: "preview-startup-summary-regression-test-ref",
      },
      encoding: "utf8",
    },
  );

  try {
    const summary = existsSync(githubStepSummaryPath)
      ? readFileSync(githubStepSummaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("hosted preview startup summary regression checks the reviewed revision", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/preview-startup-summary-regression.yml",
    ".github/workflows/preview-startup-real-platform.yml",
    ".replit",
    "artifacts/chat-app/package.json",
    "artifacts/chat-app/scripts/refresh-preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-shared.mjs",
    "artifacts/chat-app/scripts/preview-launch-evidence.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.test.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup-runtime-diagnostic.test.mjs",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.type, "string");
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const jobs = Object.entries(workflow.jobs);
  assert.deepEqual(
    jobs.map(([jobId]) => jobId),
    ["verify-hosted-summary", "measure-preview-timing"],
  );
  const [, job] = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);

  assert.equal(
    job.steps[1].uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(job.steps[1].with.version, "10.26.1");
  assert.equal(job.steps[2].uses, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  assert.equal(job.steps[2].with["node-version"], 24);
  assert.equal(job.steps[2].with.cache, "pnpm");
  assert.equal(job.steps[3].run, "pnpm install --frozen-lockfile");

  const verification = job.steps[4].run;
  assert.deepEqual(job.steps[4].env, {
    REVIEWED_REF:
      "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  });
  assert.match(
    verification,
    /node artifacts\/chat-app\/scripts\/validate-preview-startup\.mjs\s+\\\s*\n\s+--log-file/,
  );
  assert.match(
    verification,
    /GITHUB_STEP_SUMMARY="\$failure_summary_path"\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(verification, /Expo preview startup output is healthy:/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=handoff-server-stall-manifest/,
  );
  assert.match(
    verification,
    /manifest response headers received but body did not complete/,
  );
  assert.match(
    verification,
    /250ms configured local handoff deadline/,
  );
  assert.match(
    verification,
    /The hosted Metro body-stall summary did not retain safe failure and recovery guidance/,
  );
  assert.match(verification, /bounded missing-library diagnosis/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=unexpected-startup-failure/,
  );
  assert.match(
    verification,
    /The hosted unexpected-startup summary exposed raw output or lost its bounded diagnosis/,
  );
  assert.match(
    verification,
    /Preview startup could not be confirmed\. See the workflow log for details\./,
  );
  assert.match(verification, /expected_library_identifier="libgtk-3\.so\.0"/);
  assert.match(
    verification,
    /expected_failure_summary_path="\$\(mktemp\)"/,
  );
  assert.match(
    verification,
    /cmp -s "\$failure_summary_path" "\$expected_failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_library_identifier" "\$failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_diagnosis" "\$GITHUB_STEP_SUMMARY"/,
  );
  assert.match(
    verification,
    /published hosted summary exposed raw child-process output or private material/,
  );
  assert.match(verification, /private material/);
  assert.match(
    verification,
    /contained output beyond the bounded diagnosis/,
  );
  const staleBaselineIndex = verification.indexOf(
    "PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION=0.0.0",
  );
  const healthyValidationIndex = verification.indexOf(
    "printf 'Starting Metro Bundler\\n' > \"$healthy_log\"",
  );
  assert.ok(
    staleBaselineIndex >= 0 && staleBaselineIndex < healthyValidationIndex,
    "the stale-tooling baseline must run before the healthy captured-log check",
  );
  const staleSummaryPublishIndex = verification.indexOf(
    'cat "$tooling_summary_path"',
  );
  const malformedSettingIndex = verification.indexOf(
    "malformed_preview_setting=",
  );
  assert.ok(
    staleSummaryPublishIndex >= 0 &&
      staleSummaryPublishIndex < malformedSettingIndex &&
      verification.includes('>> "$GITHUB_STEP_SUMMARY"'),
    "stale-tooling guidance must reach the real workflow summary before later checks",
  );
  assert.match(verification, /malformed_preview_setting/);
  assert.match(
    verification,
    /malformed preview-setting diagnosis/,
  );
  assert.match(
    verification,
    /malformed preview-setting summary contained private material/,
  );
  assert.match(verification, /base64 --decode/);
  assert.match(verification, /"\$GITHUB_STEP_SUMMARY"/);
  const revisionMetadataIndex = verification.indexOf(
    'echo "## Reviewed preview startup revision"',
  );
  const publishedSummaryIndex = verification.indexOf(
    'echo "## Preview startup summary regression"',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < publishedSummaryIndex,
    "the hosted preview summary must publish revision metadata before its result sections",
  );
  assert.match(
    verification,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*safe_reviewed_ref="\$\(sanitize_workflow_text "\$REVIEWED_REF"\)/,
  );
  assert.doesNotMatch(
    verification,
    /secrets\.|EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL|cat "\$healthy_log"/,
    "the hosted preview revision summary must not expose secrets or raw logs",
  );
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL/);
});

test("hosted preview timing evidence covers every supported runner profile", () => {
  const timingJob = workflow.jobs["measure-preview-timing"];
  assert.equal(timingJob["runs-on"], "${{ matrix.os }}");
  assert.equal(timingJob["timeout-minutes"], 30);
  assert.deepEqual(timingJob.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  const timingStep = timingJob.steps.at(-1);
  assert.equal(timingStep.name, "Measure startup, public preview, and local handoff phases");
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_LAUNCHER=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_HANDOFF=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_SKIP_PUBLIC=1/);
  assert.match(timingStep.run, /REPLIT_EXPO_SESSION_SECRET=/);
  assert.match(timingStep.run, /PREVIEW_TIMING_OUTPUT="\$timing_path"/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /PREVIEW_HANDOFF_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /preview-startup-timing\/v1/);
  assert.match(timingStep.run, /timing\.maxTimeoutMs !== 300000/);
  assert.match(timingStep.run, /evidence\.elapsedMs >= budgetMs/);
  assert.match(timingStep.run, /publicPreview\.status !== "NOT_ASSESSED"/);
  assert.doesNotMatch(timingStep.run, /PREVIEW_STARTUP_TEST_FIXTURE|preview-timing\.test/);
});

test("hosted preview startup checks remain read-only", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});

test("hosted preview startup workflow summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-long-path",
  });
  const lines = result.summary.split("\n");

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(lines.length, 7, `${result.stdout}${result.stderr}`);
  assert.equal(lines[0], "### Expo preview startup");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "**Status:** FAIL");
  assert.equal(lines[3], "");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "");
  assert.match(
    lines[4],
    /^\*\*Diagnosis:\*\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools: error while loading shared libraries: [^\r\n]*\(missing runtime library: [^\r\n]*libgtk-3\.so\.0\)[ \t]*$/,
  );
});

test("hosted preview startup workflow invalid-setting summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_PUBLIC_URL: "https://[preview-setting-secret",
    PREVIEW_PUBLIC_TIMEOUT_MS: "25",
    PREVIEW_STARTUP_TIMEOUT_MS: "2000",
    PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(
    result.summary,
    extractWorkflowHereDoc("expected_setting_summary_path"),
  );
});

test("hosted preview startup workflow step succeeds end-to-end", () => {
  const result = runWorkflowVerificationStep();

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.summary, /## Reviewed preview startup revision/);
  assert.match(result.summary, /## Preview startup summary regression/);
  assert.match(
    result.summary,
    /Healthy captured startup: \*\*PASS\*\* \(success output retained; no failure section\)/,
  );
  assert.match(
    result.summary,
    /Malformed preview setting: \*\*PASS\*\* \(configuration diagnosis retained; private material excluded\)/,
  );
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/preview-startup-summary-regression.yml",
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const workflowText = readFileSync(workflowPath, "utf8");
const validatorPath = path.join(
  workspaceRoot,
  "artifacts/chat-app/scripts/validate-preview-startup.mjs",
);

function extractWorkflowHereDoc(variableName) {
  const match = workflowText.match(
    new RegExp(
      `cat > "\\$${variableName}" <<'EOF'\\n([\\s\\S]*?)\\n\\s*EOF`,
    ),
  );
  assert.ok(match, `workflow is missing the ${variableName} here-doc`);
  const body = match[1];
  const indents = body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const sharedIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return (
    body
      .split("\n")
      .map((line) => line.slice(sharedIndent))
      .join("\n") + "\n\n"
  );
}

function runValidator(env) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-workflow-"),
  );
  const summaryPath = path.join(temporaryDirectory, "summary.md");
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...env },
    encoding: "utf8",
  });

  try {
    const summary = existsSync(summaryPath)
      ? readFileSync(summaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runWorkflowVerificationStep() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-step-"),
  );
  const scriptPath = path.join(temporaryDirectory, "verify-hosted-summary.sh");
  const githubStepSummaryPath = path.join(temporaryDirectory, "summary.md");
  const verificationStep = workflow.jobs["verify-hosted-summary"].steps.find(
    (step) =>
      step.name === "Verify healthy and failing preview startup summaries",
  );
  assert.equal(
    typeof verificationStep?.run,
    "string",
    "hosted preview summary workflow must retain its verification script",
  );
  writeFileSync(scriptPath, verificationStep.run);

  const result = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", ". \"$1\"", "bash", scriptPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: githubStepSummaryPath,
        REVIEWED_REF: "preview-startup-summary-regression-test-ref",
      },
      encoding: "utf8",
    },
  );

  try {
    const summary = existsSync(githubStepSummaryPath)
      ? readFileSync(githubStepSummaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("hosted preview startup summary regression checks the reviewed revision", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/preview-startup-summary-regression.yml",
    ".github/workflows/preview-startup-real-platform.yml",
    ".replit",
    "artifacts/chat-app/package.json",
    "artifacts/chat-app/scripts/refresh-preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-shared.mjs",
    "artifacts/chat-app/scripts/preview-launch-evidence.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.test.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup-runtime-diagnostic.test.mjs",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.type, "string");
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const jobs = Object.entries(workflow.jobs);
  assert.deepEqual(
    jobs.map(([jobId]) => jobId),
    ["verify-hosted-summary", "measure-preview-timing"],
  );
  const [, job] = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);

  assert.equal(
    job.steps[1].uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(job.steps[1].with.version, "10.26.1");
  assert.equal(job.steps[2].uses, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  assert.equal(job.steps[2].with["node-version"], 24);
  assert.equal(job.steps[2].with.cache, "pnpm");
  assert.equal(job.steps[3].run, "pnpm install --frozen-lockfile");

  const verification = job.steps[4].run;
  assert.deepEqual(job.steps[4].env, {
    REVIEWED_REF:
      "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  });
  assert.match(
    verification,
    /node artifacts\/chat-app\/scripts\/validate-preview-startup\.mjs\s+\\\s*\n\s+--log-file/,
  );
  assert.match(
    verification,
    /PREVIEW_PUBLIC_URL=https:\/\/preview\.example\.test\/expo\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(
    verification,
    /REPLIT_EXPO_DEV_DOMAIN=fallback-preview\.example\.test\s+\\\s*\n\s+PREVIEW_PUBLIC_URL=https:\/\/preview\.example\.test\/expo\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(verification, /Expo preview startup output is healthy:/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=handoff-server-stall-manifest/,
  );
  assert.match(
    verification,
    /manifest response headers received but body did not complete/,
  );
  assert.match(
    verification,
    /250ms configured local handoff deadline/,
  );
  assert.match(
    verification,
    /The hosted Metro body-stall summary did not retain safe failure and recovery guidance/,
  );
  assert.match(verification, /bounded missing-library diagnosis/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=unexpected-startup-failure/,
  );
  assert.match(
    verification,
    /The hosted unexpected-startup summary exposed raw output or lost its bounded diagnosis/,
  );
  assert.match(
    verification,
    /Preview startup could not be confirmed\. See the workflow log for details\./,
  );
  assert.match(verification, /expected_library_identifier="libgtk-3\.so\.0"/);
  assert.match(
    verification,
    /expected_failure_summary_path="\$\(mktemp\)"/,
  );
  assert.match(
    verification,
    /cmp -s "\$failure_summary_path" "\$expected_failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_library_identifier" "\$failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_diagnosis" "\$GITHUB_STEP_SUMMARY"/,
  );
  assert.match(
    verification,
    /published hosted summary exposed raw child-process output or private material/,
  );
  assert.match(verification, /private material/);
  assert.match(
    verification,
    /diagnosis_matches="\$\(grep -E -- '\^\\\*\\\*Diagnosis:\\\*\\\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools:/,
  );
  assert.match(
    verification,
    /\.\*\\\(missing runtime library: \.\*libgtk-3\\\.so\\\.0\\\)\[\[:space:\]\]\*\$' "\$summary_path" \|\| true\)"/,
  );
  assert.match(verification, /diagnosis_line="\$diagnosis_matches"/);
  assert.match(verification, /printf '%s\\n' "\$diagnosis_line"/);
  assert.match(
    verification,
    /contained output beyond the bounded diagnosis/,
  );
  const staleBaselineIndex = verification.indexOf(
    "PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION=0.0.0",
  );
  const healthyValidationIndex = verification.indexOf(
    "printf 'Starting Metro Bundler\\n' > \"$healthy_log\"",
  );
  assert.ok(
    staleBaselineIndex >= 0 && staleBaselineIndex < healthyValidationIndex,
    "the stale-tooling baseline must run before the healthy captured-log check",
  );
  const staleSummaryPublishIndex = verification.indexOf(
    'cat "$tooling_summary_path"',
  );
  const malformedSettingIndex = verification.indexOf(
    "malformed_preview_setting=",
  );
  assert.ok(
    staleSummaryPublishIndex >= 0 &&
      staleSummaryPublishIndex < malformedSettingIndex &&
      verification.includes('>> "$GITHUB_STEP_SUMMARY"'),
    "stale-tooling guidance must reach the real workflow summary before later checks",
  );
  assert.match(verification, /malformed_preview_setting/);
  assert.match(
    verification,
    /malformed preview-setting diagnosis/,
  );
  assert.match(
    verification,
    /malformed preview-setting summary contained private material/,
  );
  assert.match(verification, /base64 --decode/);
  assert.match(verification, /"\$GITHUB_STEP_SUMMARY"/);
  const revisionMetadataIndex = verification.indexOf(
    'echo "## Reviewed preview startup revision"',
  );
  const publishedSummaryIndex = verification.indexOf(
    'echo "## Preview startup summary regression"',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < publishedSummaryIndex,
    "the hosted preview summary must publish revision metadata before its result sections",
  );
  assert.match(
    verification,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*safe_reviewed_ref="\$\(sanitize_workflow_text "\$REVIEWED_REF"\)/,
  );
  assert.doesNotMatch(
    verification,
    /secrets\.|EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL|cat "\$healthy_log"/,
    "the hosted preview revision summary must not expose secrets or raw logs",
  );
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL/);
});

test("hosted preview timing evidence covers every supported runner profile", () => {
  const timingJob = workflow.jobs["measure-preview-timing"];
  assert.equal(timingJob["runs-on"], "${{ matrix.os }}");
  assert.equal(timingJob["timeout-minutes"], 30);
  assert.deepEqual(timingJob.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  const timingStep = timingJob.steps.at(-1);
  assert.equal(timingStep.name, "Measure startup, public preview, and local handoff phases");
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_LAUNCHER=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_HANDOFF=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_SKIP_PUBLIC=1/);
  assert.match(timingStep.run, /REPLIT_EXPO_SESSION_SECRET=/);
  assert.match(timingStep.run, /PREVIEW_TIMING_OUTPUT="\$timing_path"/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /PREVIEW_HANDOFF_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /preview-startup-timing\/v1/);
  assert.match(timingStep.run, /timing\.maxTimeoutMs !== 300000/);
  assert.match(timingStep.run, /evidence\.elapsedMs >= budgetMs/);
  assert.match(timingStep.run, /publicPreview\.status !== "NOT_ASSESSED"/);
  assert.doesNotMatch(timingStep.run, /PREVIEW_STARTUP_TEST_FIXTURE|preview-timing\.test/);
});

test("hosted preview startup checks remain read-only", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});

test("hosted preview startup workflow summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-long-path",
  });
  const lines = result.summary.split("\n");

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(lines.length, 7, `${result.stdout}${result.stderr}`);
  assert.equal(lines[0], "### Expo preview startup");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "**Status:** FAIL");
  assert.equal(lines[3], "");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "");
  assert.match(
    lines[4],
    /^\*\*Diagnosis:\*\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools: error while loading shared libraries: [^\r\n]*\(missing runtime library: [^\r\n]*libgtk-3\.so\.0\)[ \t]*$/,
  );
});

test("hosted preview startup workflow invalid-setting summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_PUBLIC_URL: "https://[preview-setting-secret",
    PREVIEW_PUBLIC_TIMEOUT_MS: "25",
    PREVIEW_STARTUP_TIMEOUT_MS: "2000",
    PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(
    result.summary,
    extractWorkflowHereDoc("expected_setting_summary_path"),
  );
});

test("hosted preview startup workflow step succeeds end-to-end", () => {
  const result = runWorkflowVerificationStep();

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.summary, /## Reviewed preview startup revision/);
  assert.match(result.summary, /## Preview startup summary regression/);
  assert.match(
    result.summary,
    /Healthy captured startup: \*\*PASS\*\* \(success output retained; no failure section\)/,
  );
  assert.match(
    result.summary,
    /Malformed preview setting: \*\*PASS\*\* \(configuration diagnosis retained; private material excluded\)/,
  );
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/preview-startup-summary-regression.yml",
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const workflowText = readFileSync(workflowPath, "utf8");
const validatorPath = path.join(
  workspaceRoot,
  "artifacts/chat-app/scripts/validate-preview-startup.mjs",
);

function extractWorkflowHereDoc(variableName) {
  const match = workflowText.match(
    new RegExp(
      `cat > "\\$${variableName}" <<'EOF'\\n([\\s\\S]*?)\\n\\s*EOF`,
    ),
  );
  assert.ok(match, `workflow is missing the ${variableName} here-doc`);
  const body = match[1];
  const indents = body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const sharedIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return (
    body
      .split("\n")
      .map((line) => line.slice(sharedIndent))
      .join("\n") + "\n\n"
  );
}

function runValidator(env) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-workflow-"),
  );
  const summaryPath = path.join(temporaryDirectory, "summary.md");
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...env },
    encoding: "utf8",
  });

  try {
    const summary = existsSync(summaryPath)
      ? readFileSync(summaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runWorkflowVerificationStep() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "preview-startup-summary-step-"),
  );
  const scriptPath = path.join(temporaryDirectory, "verify-hosted-summary.sh");
  const githubStepSummaryPath = path.join(temporaryDirectory, "summary.md");
  const verificationStep = workflow.jobs["verify-hosted-summary"].steps.find(
    (step) =>
      step.name === "Verify healthy and failing preview startup summaries",
  );
  assert.equal(
    typeof verificationStep?.run,
    "string",
    "hosted preview summary workflow must retain its verification script",
  );
  writeFileSync(scriptPath, verificationStep.run);

  const result = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", ". \"$1\"", "bash", scriptPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: githubStepSummaryPath,
        REVIEWED_REF: "preview-startup-summary-regression-test-ref",
      },
      encoding: "utf8",
    },
  );

  try {
    const summary = existsSync(githubStepSummaryPath)
      ? readFileSync(githubStepSummaryPath, "utf8")
      : "";
    return {
      ...result,
      summary,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("hosted preview startup summary regression checks the reviewed revision", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/preview-startup-summary-regression.yml",
    ".github/workflows/preview-startup-real-platform.yml",
    ".replit",
    "artifacts/chat-app/package.json",
    "artifacts/chat-app/scripts/refresh-preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/preview-startup-shared.mjs",
    "artifacts/chat-app/scripts/preview-launch-evidence.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.test.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup-runtime-diagnostic.test.mjs",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_ref.type, "string");
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const jobs = Object.entries(workflow.jobs);
  assert.deepEqual(
    jobs.map(([jobId]) => jobId),
    ["verify-hosted-summary", "measure-preview-timing"],
  );
  const [, job] = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);

  assert.equal(
    job.steps[1].uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(job.steps[1].with.version, "10.26.1");
  assert.equal(job.steps[2].uses, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  assert.equal(job.steps[2].with["node-version"], 24);
  assert.equal(job.steps[2].with.cache, "pnpm");
  assert.equal(job.steps[3].run, "pnpm install --frozen-lockfile");

  const verification = job.steps[4].run;
  assert.deepEqual(job.steps[4].env, {
    REVIEWED_REF:
      "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  });
  assert.match(
    verification,
    /node artifacts\/chat-app\/scripts\/validate-preview-startup\.mjs\s+\\\s*\n\s+--log-file/,
  );
  assert.match(
    verification,
    /GITHUB_STEP_SUMMARY="\$failure_summary_path"\s+\\\s*\n\s+PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
  );
  assert.match(verification, /Expo preview startup output is healthy:/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=handoff-server-stall-manifest/,
  );
  assert.match(
    verification,
    /manifest response headers received but body did not complete/,
  );
  assert.match(
    verification,
    /250ms configured local handoff deadline/,
  );
  assert.match(
    verification,
    /The hosted Metro body-stall summary did not retain safe failure and recovery guidance/,
  );
  assert.match(verification, /bounded missing-library diagnosis/);
  assert.match(
    verification,
    /PREVIEW_STARTUP_TEST_FIXTURE=unexpected-startup-failure/,
  );
  assert.match(
    verification,
    /The hosted unexpected-startup summary exposed raw output or lost its bounded diagnosis/,
  );
  assert.match(
    verification,
    /Preview startup could not be confirmed\. See the workflow log for details\./,
  );
  assert.match(verification, /expected_library_identifier="libgtk-3\.so\.0"/);
  assert.match(
    verification,
    /expected_failure_summary_path="\$\(mktemp\)"/,
  );
  assert.match(
    verification,
    /cmp -s "\$failure_summary_path" "\$expected_failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_library_identifier" "\$failure_summary_path"/,
  );
  assert.match(
    verification,
    /grep -Fc -- "\$expected_diagnosis" "\$GITHUB_STEP_SUMMARY"/,
  );
  assert.match(
    verification,
    /published hosted summary exposed raw child-process output or private material/,
  );
  assert.match(verification, /private material/);
  assert.match(
    verification,
    /contained output beyond the bounded diagnosis/,
  );
  const staleBaselineIndex = verification.indexOf(
    "PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION=0.0.0",
  );
  const healthyValidationIndex = verification.indexOf(
    "printf 'Starting Metro Bundler\\n' > \"$healthy_log\"",
  );
  assert.ok(
    staleBaselineIndex >= 0 && staleBaselineIndex < healthyValidationIndex,
    "the stale-tooling baseline must run before the healthy captured-log check",
  );
  const staleSummaryPublishIndex = verification.indexOf(
    'cat "$tooling_summary_path"',
  );
  const malformedSettingIndex = verification.indexOf(
    "malformed_preview_setting=",
  );
  assert.ok(
    staleSummaryPublishIndex >= 0 &&
      staleSummaryPublishIndex < malformedSettingIndex &&
      verification.includes('>> "$GITHUB_STEP_SUMMARY"'),
    "stale-tooling guidance must reach the real workflow summary before later checks",
  );
  assert.match(verification, /malformed_preview_setting/);
  assert.match(
    verification,
    /malformed preview-setting diagnosis/,
  );
  assert.match(
    verification,
    /malformed preview-setting summary contained private material/,
  );
  assert.match(verification, /base64 --decode/);
  assert.match(verification, /"\$GITHUB_STEP_SUMMARY"/);
  const revisionMetadataIndex = verification.indexOf(
    'echo "## Reviewed preview startup revision"',
  );
  const publishedSummaryIndex = verification.indexOf(
    'echo "## Preview startup summary regression"',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < publishedSummaryIndex,
    "the hosted preview summary must publish revision metadata before its result sections",
  );
  assert.match(
    verification,
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"[\s\S]*safe_reviewed_ref="\$\(sanitize_workflow_text "\$REVIEWED_REF"\)/,
  );
  assert.doesNotMatch(
    verification,
    /secrets\.|EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL|cat "\$healthy_log"/,
    "the hosted preview revision summary must not expose secrets or raw logs",
  );
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL/);
});

test("hosted preview timing evidence covers every supported runner profile", () => {
  const timingJob = workflow.jobs["measure-preview-timing"];
  assert.equal(timingJob["runs-on"], "${{ matrix.os }}");
  assert.equal(timingJob["timeout-minutes"], 30);
  assert.deepEqual(timingJob.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  const timingStep = timingJob.steps.at(-1);
  assert.equal(timingStep.name, "Measure startup, public preview, and local handoff phases");
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_LAUNCHER=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_REAL_HANDOFF=1/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_SKIP_PUBLIC=1/);
  assert.match(timingStep.run, /REPLIT_EXPO_SESSION_SECRET=/);
  assert.match(timingStep.run, /PREVIEW_TIMING_OUTPUT="\$timing_path"/);
  assert.match(timingStep.run, /PREVIEW_STARTUP_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /PREVIEW_HANDOFF_TIMEOUT_MS=300000/);
  assert.match(timingStep.run, /preview-startup-timing\/v1/);
  assert.match(timingStep.run, /timing\.maxTimeoutMs !== 300000/);
  assert.match(timingStep.run, /evidence\.elapsedMs >= budgetMs/);
  assert.match(timingStep.run, /publicPreview\.status !== "NOT_ASSESSED"/);
  assert.doesNotMatch(timingStep.run, /PREVIEW_STARTUP_TEST_FIXTURE|preview-timing\.test/);
});

test("hosted preview startup checks remain read-only", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});

test("hosted preview startup workflow summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-long-path",
  });
  const lines = result.summary.split("\n");

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(lines.length, 7, `${result.stdout}${result.stderr}`);
  assert.equal(lines[0], "### Expo preview startup");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "**Status:** FAIL");
  assert.equal(lines[3], "");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "");
  assert.match(
    lines[4],
    /^\*\*Diagnosis:\*\* Expo preview startup error: Error: \/opt\/expo\/react-native-devtools: error while loading shared libraries: [^\r\n]*\(missing runtime library: [^\r\n]*libgtk-3\.so\.0\)[ \t]*$/,
  );
});

test("hosted preview startup workflow invalid-setting summary matches validator output exactly", () => {
  const result = runValidator({
    PREVIEW_PUBLIC_URL: "https://[preview-setting-secret",
    PREVIEW_PUBLIC_TIMEOUT_MS: "25",
    PREVIEW_STARTUP_TIMEOUT_MS: "2000",
    PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(
    result.summary,
    extractWorkflowHereDoc("expected_setting_summary_path"),
  );
});

test("hosted preview startup workflow step succeeds end-to-end", () => {
  const result = runWorkflowVerificationStep();

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.summary, /## Reviewed preview startup revision/);
  assert.match(result.summary, /## Preview startup summary regression/);
  assert.match(
    result.summary,
    /Healthy captured startup: \*\*PASS\*\* \(success output retained; no failure section\)/,
  );
  assert.match(
    result.summary,
    /Malformed preview setting: \*\*PASS\*\* \(configuration diagnosis retained; private material excluded\)/,
  );
});
