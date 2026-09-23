import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatDeclarationInstructions,
  formatMarkdownDeclarationInstructions,
  formatPullRequestDeclarationFields,
} from "./check-contract-compatibility.mjs";
import {
  describeGeneratedChange,
  formatFileDiff,
} from "./generated-drift-report.mjs";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

export const guidancePaths = Object.freeze({
  workflow: resolve(workspaceRoot, ".github/workflows/api-codegen.yml"),
  contributorGuide: resolve(workspaceRoot, "replit.md"),
  pullRequestTemplate: resolve(
    workspaceRoot,
    ".github/pull_request_template.md",
  ),
});
const guidanceDisplayPaths = Object.freeze({
  workflow: ".github/workflows/api-codegen.yml",
  contributorGuide: "replit.md",
  pullRequestTemplate: ".github/pull_request_template.md",
});

const workflowGuidancePattern =
  /(      - name: Verify generated API-break guidance\n        run: pnpm validate:api-break-guidance\n\n)[\s\S]*?(?=\n      # Pull request runs reject breaking changes)/;
const contributorGuidancePattern =
  /(### API compatibility override instructions\n\n)[\s\S]*?(\n\n## Stack)/;
const pullRequestGuidancePattern =
  /(<!-- BEGIN GENERATED API-BREAK GUIDANCE -->\n)[\s\S]*?(\n<!-- END GENERATED API-BREAK GUIDANCE -->)/;
export const guidanceDiffLimits = Object.freeze({
  contextLines: 2,
  maxLinesPerFile: 40,
  maxTotalLines: 80,
  maxLineLength: 200,
});

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Unable to find ${label} guidance block`);
  }
  return source.replace(pattern, replacement);
}

export function renderSynchronizedGuidance({
  workflow,
  contributorGuide,
  pullRequestTemplate,
}) {
  const workflowGuidance = formatDeclarationInstructions()
    .map((line) => `      #${line ? ` ${line}` : ""}`)
    .join("\n");
  const markdownGuidance = formatMarkdownDeclarationInstructions().join("\n");
  const pullRequestGuidance = formatPullRequestDeclarationFields().join("\n");

  return {
    workflow: replaceRequired(
      workflow,
      workflowGuidancePattern,
      `$1${workflowGuidance}`,
      "workflow",
    ),
    contributorGuide: replaceRequired(
      contributorGuide,
      contributorGuidancePattern,
      `$1${markdownGuidance}$2`,
      "contributor",
    ),
    pullRequestTemplate: replaceRequired(
      pullRequestTemplate,
      pullRequestGuidancePattern,
      `$1${pullRequestGuidance}$2`,
      "pull request template",
    ),
  };
}

function formatStaleGuidanceDiff(key, current, expected) {
  const change = describeGeneratedChange(
    guidanceDisplayPaths[key],
    Buffer.from(current),
    Buffer.from(expected),
    guidanceDiffLimits,
  );
  return [
    `Stale ${key} guidance diff (a/ = checked in, b/ = expected):`,
    ...formatFileDiff(change, guidanceDiffLimits),
  ].join("\n");
}

function formatStaleGuidanceFailure(stale, diffs) {
  const summary = `Generated API-break guidance is stale in: ${stale.join(", ")}.`;
  const repair = "Run pnpm sync:api-break-guidance.";
  const previewLines = diffs.flatMap((diff, index) => [
    ...(index === 0 ? [] : [""]),
    ...diff.split("\n"),
  ]);
  const complete = [summary, "", ...previewLines, "", repair];
  if (complete.length <= guidanceDiffLimits.maxTotalLines) {
    return complete.join("\n");
  }

  // Preserve the summary, aggregate omission marker, and repair command inside
  // the configured complete-message budget.
  const shownCount = guidanceDiffLimits.maxTotalLines - 5;
  const shownLines = previewLines.slice(0, shownCount);
  let consumed = 0;
  let omittedFiles = 0;
  for (const diff of diffs) {
    const lineCount = diff.split("\n").length;
    if (consumed + lineCount > shownCount) {
      omittedFiles += 1;
    }
    consumed += lineCount + 1;
  }
  const omittedLines = previewLines.length - shownLines.length;
  return [
    summary,
    "",
    ...shownLines,
    `... total guidance preview limit of ${guidanceDiffLimits.maxTotalLines} lines reached; ${omittedLines} more preview line(s) across ${omittedFiles} stale guidance file(s) omitted.`,
    "",
    repair,
  ].join("\n");
}

export function synchronizeGuidance({
  check = false,
  paths = guidancePaths,
} = {}) {
  const current = {
    workflow: readFileSync(paths.workflow, "utf8"),
    contributorGuide: readFileSync(paths.contributorGuide, "utf8"),
    pullRequestTemplate: readFileSync(paths.pullRequestTemplate, "utf8"),
  };
  const expected = renderSynchronizedGuidance(current);
  const stale = Object.keys(current).filter(
    (key) => current[key] !== expected[key],
  );

  if (check) {
    if (stale.length > 0) {
      const diffs = stale.map((key) =>
        formatStaleGuidanceDiff(key, current[key], expected[key]),
      );
      throw new Error(formatStaleGuidanceFailure(stale, diffs));
    }
    return [];
  }

  for (const key of stale) {
    writeFileSync(paths[key], expected[key]);
  }
  return stale;
}

function main() {
  const args = process.argv.slice(2);
  const paths = { ...guidancePaths };
  const pathArguments = Object.freeze({
    "--workflow-file": "workflow",
    "--contributor-guide-file": "contributorGuide",
    "--pull-request-template-file": "pullRequestTemplate",
  });
  const supportedOptions = [
    "--check",
    ...Object.keys(pathArguments).map((option) => `${option} <path>`),
  ].join(", ");
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    const pathKey = pathArguments[argument];
    if (!pathKey) {
      throw new Error(
        `Unknown argument: ${argument}\nSupported options: ${supportedOptions}`,
      );
    }
    const path = args[index + 1];
    if (!path || path.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    paths[pathKey] = resolve(path);
    index += 1;
  }
  const changed = synchronizeGuidance({ check, paths });
  console.log(
    check
      ? "Generated API-break guidance is current."
      : changed.length > 0
        ? `Updated generated API-break guidance in: ${changed.join(", ")}.`
        : "Generated API-break guidance is already current.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
