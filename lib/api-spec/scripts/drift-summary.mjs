// Builds the reviewer-visible generated-client drift evidence. The same
// rendering is used for GitHub's step summary and for the published check run
// so a reviewer reads identical evidence wherever they open it.

export const regenerationCommand =
  "pnpm --filter @workspace/api-spec run codegen";
export const driftSummaryTitle = "Generated API drift detected";
// GitHub rejects a check-run output summary longer than 65535 characters.
export const checkRunSummaryLimit = 65535;

export function markdownFence(text) {
  const longestBacktickRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function render(report) {
  // The report is generated content, so it is always rendered inside a fence
  // longer than any backtick run it contains and never as raw Markdown.
  const fence = markdownFence(report);
  return [
    `## ${driftSummaryTitle}`,
    "",
    `Regenerate with \`${regenerationCommand}\` and commit the generated output.`,
    "",
    `${fence}diff`,
    report,
    fence,
    "",
  ].join("\n");
}

function truncationNotice(limit, omittedLines) {
  return `... evidence truncated to fit GitHub's ${limit}-character check summary limit; ${omittedLines} more report line(s) remain in the job log.`;
}

export function buildDriftSummary(report, { limit } = {}) {
  const summary = render(report);
  if (limit === undefined || summary.length <= limit) {
    return summary;
  }

  const lines = report.split("\n");
  // Binary search for the largest number of retained report lines that still
  // fits, so a very large report does not cost one render per removed line.
  let low = 0;
  let high = lines.length;
  let best;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(
      [
        ...lines.slice(0, middle),
        truncationNotice(limit, lines.length - middle),
      ].join("\n"),
    );
    if (candidate.length <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  // Even the heading, regeneration command, and notice can exceed a very small
  // limit. Returning a hard-truncated body keeps the evidence bounded rather
  // than letting GitHub reject the whole publication.
  return best ?? render("").slice(0, limit);
}
