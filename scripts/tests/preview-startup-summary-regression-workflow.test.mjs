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
    "artifacts/chat-app/scripts/preview-startup-runtime-library-fixture.mjs",
    "artifacts/chat-app/scripts/validate-preview-startup.mjs",
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
  assert.equal(job.steps.length, 2);
  assert.equal(job.steps[0].uses, "actions/checkout@v4");
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event.pull_request.head.sha || inputs.reviewed_ref }}",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);

  const verification = job.steps[1].run;
  assert.deepEqual(job.steps[1].env, {
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
  assert.match(verification, /bounded missing-library diagnosis/);
  assert.match(verification, /private material/);
  assert.match(
    verification,
    /contained output beyond the bounded diagnosis/,
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
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /EAS_TOKEN|CLERK_SECRET_KEY|DATABASE_URL/);
});

test("hosted preview startup summary regression is a read-only Linux check", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /runs-on:\s*.*(?:macos|windows)/i);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);
});