import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDriftSummary,
  checkRunSummaryLimit,
  driftSummaryTitle,
  regenerationCommand,
} from "./drift-summary.mjs";

test("renders the changed paths, the report, and the regeneration command", () => {
  const report = [
    "Generated API drift detected after regeneration:",
    "",
    "- lib/api-client-react/src/generated/api.schemas.ts (modified: +1 -1)",
  ].join("\n");

  const summary = buildDriftSummary(report);

  assert.equal(
    summary,
    [
      `## ${driftSummaryTitle}`,
      "",
      `Regenerate with \`${regenerationCommand}\` and commit the generated output.`,
      "",
      "```diff",
      report,
      "```",
      "",
    ].join("\n"),
  );
});

test("keeps generated backticks inside the fence", () => {
  const report = "+``` nested fence\n+```` wider nested fence";

  const summary = buildDriftSummary(report);

  assert.match(summary, /^`````diff$/m);
  assert.match(summary, /^`````$/m);
});

test("leaves a report that already fits the check-run limit unchanged", () => {
  const report = "- lib/api-client-react/src/generated/api.schemas.ts";

  assert.equal(
    buildDriftSummary(report, { limit: checkRunSummaryLimit }),
    buildDriftSummary(report),
  );
});

test("bounds an oversized report and says how much was omitted", () => {
  const lines = Array.from(
    { length: 5000 },
    (_, index) => `+ generated line ${index + 1}`,
  );
  const report = [
    "- lib/api-client-react/src/generated/api.schemas.ts (modified)",
    ...lines,
  ].join("\n");

  const summary = buildDriftSummary(report, { limit: checkRunSummaryLimit });

  assert.ok(
    summary.length <= checkRunSummaryLimit,
    `the summary must fit GitHub's limit, got ${summary.length} characters`,
  );
  assert.match(summary, /lib\/api-client-react\/src\/generated\/api\.schemas\.ts/);
  assert.match(summary, new RegExp(`Regenerate with \`${regenerationCommand.replace(/[/\\]/g, "\\$&")}\``));
  assert.match(
    summary,
    /\.\.\. evidence truncated to fit GitHub's 65535-character check summary limit; \d+ more report line\(s\) remain in the job log\./,
  );
  const omitted = Number(
    /; (\d+) more report line/.exec(summary)?.[1] ?? "0",
  );
  assert.ok(omitted > 0, "the notice must report the omitted line count");
});

test("stays within a limit too small for any report line", () => {
  const summary = buildDriftSummary("+ generated line", { limit: 40 });

  assert.ok(
    summary.length <= 40,
    `the summary must stay bounded, got ${summary.length} characters`,
  );
});
