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
const guidanceDiffLimits = Object.freeze({
  contextLines: 2,
  maxLinesPerFile: 40,
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
      throw new Error(
        [
          `Generated API-break guidance is stale in: ${stale.join(", ")}.`,
          ...diffs,
          "Run pnpm sync:api-break-guidance.",
        ].join("\n\n"),
      );
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
  if (args.some((argument) => argument !== "--check")) {
    throw new Error(
      `Unknown argument: ${args.find((argument) => argument !== "--check")}`,
    );
  }
  const check = args.includes("--check");
  const changed = synchronizeGuidance({ check });
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
