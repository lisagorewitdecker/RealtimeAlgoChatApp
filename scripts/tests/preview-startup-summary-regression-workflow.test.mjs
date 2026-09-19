import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    ["verify-hosted-summary"],
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
    /PREVIEW_STARTUP_TEST_FIXTURE=missing-runtime-library-long-path/,
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

test("hosted preview startup summary regression is a read-only Linux check", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /runs-on:\s*.*(?:macos|windows)/i);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});