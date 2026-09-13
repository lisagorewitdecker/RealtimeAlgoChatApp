import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatDeclarationInstructions,
  formatMarkdownDeclarationInstructions,
} from "./check-contract-compatibility.mjs";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

export const guidancePaths = Object.freeze({
  workflow: resolve(workspaceRoot, ".github/workflows/api-codegen.yml"),
  contributorGuide: resolve(workspaceRoot, "replit.md"),
});

const workflowGuidancePattern =
  /(      - name: Verify generated API-break guidance\n        run: pnpm validate:api-break-guidance\n\n)[\s\S]*?(?=\n      # Pull request runs reject breaking changes)/;
const contributorGuidancePattern =
  /(### API compatibility override instructions\n\n)[\s\S]*?(\n\n## Stack)/;

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Unable to find ${label} guidance block`);
  }
  return source.replace(pattern, replacement);
}

export function renderSynchronizedGuidance({ workflow, contributorGuide }) {
  const workflowGuidance = formatDeclarationInstructions()
    .map((line) => `      #${line ? ` ${line}` : ""}`)
    .join("\n");
  const markdownGuidance = formatMarkdownDeclarationInstructions().join("\n");

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
  };
}

export function synchronizeGuidance({
  check = false,
  paths = guidancePaths,
} = {}) {
  const current = {
    workflow: readFileSync(paths.workflow, "utf8"),
    contributorGuide: readFileSync(paths.contributorGuide, "utf8"),
  };
  const expected = renderSynchronizedGuidance(current);
  const stale = Object.keys(current).filter(
    (key) => current[key] !== expected[key],
  );

  if (check) {
    if (stale.length > 0) {
      throw new Error(
        `Generated API-break guidance is stale in: ${stale.join(", ")}. Run pnpm sync:api-break-guidance.`,
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
