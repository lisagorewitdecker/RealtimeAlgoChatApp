import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const fixturePath = path.join(
  workspaceRoot,
  "scripts/tests/native-evidence-summary-regression-fixture.sh",
);
const fixtureText = readFileSync(fixturePath, "utf8");

test("hosted summary regression checks only the reviewed ref", () => {
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/native-evidence-summary-regression.yml",
    "scripts/check-native-large-text-evidence.sh",
    "scripts/run-untrusted-checker.sh",
    "scripts/tests/native-evidence-summary-regression-fixture.sh",
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
    NATIVE_EVIDENCE_HOSTILE_METADATA: "1",
  });
  assert.equal(
    verification.trim(),
    "bash scripts/tests/native-evidence-summary-regression-fixture.sh \\\n  bash scripts/check-native-large-text-evidence.sh",
  );
  assert.match(fixtureText, /resolved_commit_sha="\$\(git .*rev-parse --verify HEAD\)"/);
  assert.match(fixtureText, /Checked ref: `%s`/);
  assert.match(fixtureText, /Resolved commit SHA: `%s`/);
  assert.match(fixtureText, /"\$GITHUB_STEP_SUMMARY"/);
  assert.match(
    fixtureText,
    /scripts\/run-untrusted-checker\.sh" "\$@" "\$blocked_root"/,
  );
  assert.match(
    fixtureText,
    /base64 --decode[\s\S]*NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT/,
    "hostile metadata must be assembled from encoded values at runtime",
  );
  assert.match(
    fixtureText,
    /checker_stdout="\$\(mktemp\)"[\s\S]*checker_stderr="\$\(mktemp\)"/,
    "checker stdout and stderr must be captured before they are printed",
  );
  const revisionMetadataIndex = fixtureText.indexOf(
    'echo "## Reviewed release revision"',
  );
  const checkerIndex = fixtureText.indexOf(
    'if env "${checker_env[@]}" bash',
  );
  assert.ok(
    revisionMetadataIndex >= 0 && revisionMetadataIndex < checkerIndex,
    "trusted revision metadata must be written before the checker can fail",
  );
  assert.match(fixtureText, /Missing result directory: \$blocked_root\/ios/);
  assert.match(
    fixtureText,
    /Missing result directory: \$blocked_root\/android/,
  );
  assert.match(
    fixtureText,
    /Expected the platform-specific missing result finding/,
  );
  assert.match(
    fixtureText,
    /Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts\./,
  );
  assert.match(fixtureText, /\$GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(
    fixtureText,
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

test("hosted summary keeps revision metadata when the checker fails", () => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "native-evidence-summary-regression-"),
  );
  const summaryPath = path.join(fixtureRoot, "job-summary.md");
  const checkerPath = path.join(fixtureRoot, "synthetic-checker.sh");
  const reviewedRef = "synthetic-reviewed-ref";
  const resolvedCommitSha = execFileSync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: workspaceRoot, encoding: "utf8" },
  ).trim();

  try {
    writeFileSync(
      checkerPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'blocked_root="$1"',
        "{",
        '  echo "<!-- synthetic checker output -->"',
        '  echo "## iOS native large-text evidence"',
        '  echo "- Status: **FAIL**"',
        '  echo "- Validated run directory: **Unavailable**"',
        '  echo "- Detailed evidence report: **Unavailable**"',
        '  echo "### Blocking evidence findings"',
        "  printf -- '- `Missing result directory: %s/ios. Run the ios native large-text gate and upload its timestamped result directory.`\\n' \"$blocked_root\"",
        '  echo "## Android native large-text evidence"',
        '  echo "- Status: **FAIL**"',
        '  echo "- Validated run directory: **Unavailable**"',
        '  echo "- Detailed evidence report: **Unavailable**"',
        '  echo "### Blocking evidence findings"',
        "  printf -- '- `Missing result directory: %s/android. Run the android native large-text gate and upload its timestamped result directory.`\\n' \"$blocked_root\"",
        '} >> "$GITHUB_STEP_SUMMARY"',
        "exit 41",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync(
      "bash",
      [fixturePath, "bash", checkerPath],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          REVIEWED_REF: reviewedRef,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(
      summary,
      new RegExp(`- Checked ref: \`${reviewedRef}\``),
    );
    assert.match(summary, new RegExp(`- Resolved commit SHA: \`${resolvedCommitSha}\``));
    assert.match(summary, /<!-- synthetic checker output -->/);
    assert.match(summary, /## iOS native large-text evidence/);
    assert.match(summary, /## Android native large-text evidence/);
    assert.ok(
      summary.indexOf("## Reviewed release revision") <
        summary.indexOf("<!-- synthetic checker output -->"),
      "trusted revision metadata must precede appended checker findings",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
