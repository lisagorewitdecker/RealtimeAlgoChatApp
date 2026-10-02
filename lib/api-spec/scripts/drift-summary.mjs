export const regenerationCommand =
  "pnpm --filter @workspace/api-spec run codegen";
export const driftSummaryTitle = "Generated API drift detected";
export const checkRunSummaryLimit = 65535;

export function markdownFence(text) {
  const longestBacktickRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function render(report) {
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

  return best ?? render("").slice(0, limit);
}
