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
    path.join(workspaceRoot, ".github/workflows/api-codegen.yml"),
    "utf8",
  ),
);
const rootPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
);

const steps = workflow.jobs?.["check-generated"]?.steps ?? [];
const compatibilityStep = steps.find(
  (step) => step.name === "Check API contract compatibility",
);

function resolveRootPackageScript(command) {
  const match = String(command).trim().match(/^pnpm(?:\s+run)?\s+([^\s]+)$/);
  assert.ok(
    match,
    `expected a single root pnpm package script command, received: ${command}`,
  );

  const scriptName = match[1];
  const resolvedCommand = rootPackage.scripts?.[scriptName];
  assert.equal(
    typeof resolvedCommand,
    "string",
    `expected root package.json to define the ${scriptName} script`,
  );
  return resolvedCommand;
}

test("API compatibility still runs after generated-client failures", () => {
  assert.ok(
    compatibilityStep,
    "expected the API codegen workflow to contain the compatibility step",
  );

  const condition = String(compatibilityStep.if ?? "")
    .replace(/\$\{\{|\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  assert.match(
    condition,
    /\balways\s*\(\s*\)/,
    "compatibility must use always() so an earlier generated-client failure does not skip it",
  );

  const requiredPrerequisites = [
    "checkout",
    "setup-pnpm",
    "setup-node",
    "install-dependencies",
  ];

  for (const stepId of requiredPrerequisites) {
    assert.match(
      condition,
      new RegExp(
        `\\bsteps\\.${stepId}\\.outcome\\s*==\\s*['"]success['"]`,
      ),
      `compatibility must require the ${stepId} step to succeed`,
    );
  }

  const guardedStepIds = [
    ...condition.matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.outcome\b/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(guardedStepIds)].sort(),
    [...requiredPrerequisites].sort(),
    "only setup prerequisites may guard compatibility; generated-client failure must not skip it",
  );
});

test("API compatibility workflow command resolves to the maintained contract checker", () => {
  assert.ok(
    compatibilityStep,
    "expected the API codegen workflow to contain the compatibility step",
  );

  assert.equal(
    resolveRootPackageScript(compatibilityStep.run),
    "node lib/api-spec/scripts/check-contract-compatibility.mjs",
    "the compatibility workflow must invoke the repository's maintained contract compatibility checker through the root package script",
  );
});
