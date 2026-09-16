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
const workflow = YAML.parse(
  readFileSync(
    path.join(
      workspaceRoot,
      ".github/workflows/native-evidence-summary-regression.yml",
    ),
    "utf8",
  ),
);
const workflowText = readFileSync(
  path.join(
    workspaceRoot,
    ".github/workflows/native-evidence-summary-regression.yml",
  ),
  "utf8",
);

test("hosted summary regression checks only the reviewed ref", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/native-evidence-summary-regression.yml",
    "scripts/check-native-large-text-evidence.sh",
    "scripts/run-untrusted-checker.sh",
  ]);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.reviewed_ref.required,
    true,
  );
  assert.equal(
    workflow.on.workflow_dispatch.inputs.reviewed_ref.type,
    "string",
  );
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
    /resolved_commit_sha="\$\(git rev-parse --verify HEAD\)"/,
  );
  assert.match(verification, /Checked ref: `%s`/);
  assert.match(verification, /Resolved commit SHA: `%s`/);
  assert.match(verification, /"\$GITHUB_STEP_SUMMARY"/);
  assert.match(
    verification,
    /scripts\/run-untrusted-checker\.sh bash scripts\/check-native-large-text-evidence\.sh/,
  );
  const revisionMetadataIndex = verification.indexOf(
    'echo "## Reviewed release revision"',
  );
  const checkerIndex = verification.indexOf(
    'if GITHUB_STEP_SUMMARY="$summary_path" bash scripts/run-untrusted-checker.sh',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < checkerIndex,
    "trusted revision metadata must be written before the checker can fail",
  );
  assert.match(verification, /Missing result directory: \$blocked_root\/ios/);
  assert.match(
    verification,
    /Missing result directory: \$blocked_root\/android/,
  );
  assert.match(
    verification,
    /Expected exactly one platform-specific blocking finding/,
  );
  assert.match(verification, /\$GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(
    verification,
    /summary_path.*(?:REVIEWED_REF|resolved_commit_sha)|(?:REVIEWED_REF|resolved_commit_sha).*summary_path/,
  );
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
});

test("hosted summary regression cannot publish or start native jobs", () => {
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /\bpublish\b/i);
  assert.doesNotMatch(
    workflowText,
    /EAS_TOKEN|candidate_build_id|NATIVE_SMOKE/,
  );
  assert.doesNotMatch(workflowText, /runs-on:\s*.*(?:macos|self-hosted)/i);
});
