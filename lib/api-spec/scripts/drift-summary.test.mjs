import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDriftSummary,
  checkRunSummaryLimit,
  driftSummaryTitle,
  markdownFence,
  regenerationCommand,
} from "./drift-summary.mjs";

test("markdownFence exceeds the longest backtick run in generated content", () => {
  assert.equal(markdownFence("plain text"), "```");
  assert.equal(markdownFence("```` nested"), "`````");
});

test("buildDriftSummary renders reviewer guidance and a fenced diff block", () => {
  const report = "--- a/file.ts\n+++ b/file.ts\n+``` nested fence";
  const summary = buildDriftSummary(report);

  assert.match(summary, new RegExp(`## ${driftSummaryTitle}`));
  assert.match(
    summary,
    new RegExp(
      `Regenerate with \`${regenerationCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` and commit the generated output\\.`,
    ),
  );
  assert.match(
    summary,
    /````diff\n--- a\/file\.ts\n\+\+\+ b\/file\.ts\n\+``` nested fence\n````\n$/,
  );
});

test("buildDriftSummary truncates large reports to the requested limit", () => {
  const report = Array.from({ length: 4000 }, (_, index) => `line ${index + 1}`).join(
    "\n",
  );
  const summary = buildDriftSummary(report, { limit: 512 });

  assert.ok(summary.length <= 512, `summary length ${summary.length} exceeded 512`);
  assert.match(summary, /evidence truncated to fit GitHub's 512-character check summary limit/);
});

test("buildDriftSummary respects GitHub's check-run limit", () => {
  const report = Array.from(
    { length: 12000 },
    (_, index) => `generated diff line ${index + 1}`,
  ).join("\n");
  const summary = buildDriftSummary(report, { limit: checkRunSummaryLimit });

  assert.ok(summary.length <= checkRunSummaryLimit);
});

test("buildDriftSummary falls back to a hard truncation for tiny limits", () => {
  const summary = buildDriftSummary("report body", { limit: 12 });

  assert.equal(summary.length, 12);
});
