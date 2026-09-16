import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    path.join(workspaceRoot, ".github/workflows/api-codegen.yml"),
    "utf8",
  ),
);
const rootPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
);
const apiSpecPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "lib/api-spec/package.json"), "utf8"),
);
const generatedCheckerSource = readFileSync(
  path.join(workspaceRoot, "lib/api-spec/scripts/check-generated.mjs"),
  "utf8",
);

const steps = workflow.jobs?.["check-generated"]?.steps ?? [];
const generatedClientStep = steps.find(
  (step) => step.name === "Verify generated API clients",
);
const compatibilityStep = steps.find(
  (step) => step.name === "Check API contract compatibility",
);
const generatedClientFixturePath = "lib/api-client-react/src/generated/api.ts";
const pullRequestTrigger = workflow.on?.pull_request;

function resolveRootPackageScript(command) {
  const match = String(command)
    .trim()
    .match(/^pnpm(?:\s+run)?\s+([^\s]+)$/);
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

function resolveApiSpecPackageScript(command) {
  const match = String(command)
    .trim()
    .match(/^pnpm\s+--filter\s+@workspace\/api-spec\s+run\s+([^\s]+)$/);
  assert.ok(
    match,
    `expected an API specification package script command, received: ${command}`,
  );

  const scriptName = match[1];
  const resolvedCommand = apiSpecPackage.scripts?.[scriptName];
  assert.equal(
    typeof resolvedCommand,
    "string",
    `expected lib/api-spec/package.json to define the ${scriptName} script`,
  );
  return resolvedCommand;
}

test("API codegen workflow runs for the complete development pull-request event set", () => {
  assert.ok(
    pullRequestTrigger,
    "the API codegen workflow must define a pull_request trigger",
  );
  assert.deepEqual(
    pullRequestTrigger.branches,
    ["development"],
    "the API codegen workflow pull_request trigger must target the development base branch",
  );
  assert.deepEqual(
    pullRequestTrigger.types,
    ["opened", "synchronize", "reopened", "edited"],
    "the API codegen workflow pull_request trigger must include opened, synchronize, reopened, and edited events",
  );
});

test("API compatibility receives the current pull request description", () => {
  assert.ok(
    compatibilityStep,
    "expected the API codegen workflow to contain the compatibility step",
  );
  assert.equal(
    compatibilityStep.env?.API_BREAKING_CHANGE_PR_BODY,
    "${{ github.event.pull_request.body }}",
    "the compatibility command must receive the current pull request body so description edits refresh its decision",
  );
});

test("root unit validation runs the API codegen workflow contract suite", () => {
  const unitCommands = String(rootPackage.scripts?.["test:unit"] ?? "")
    .split("&&")
    .map((command) => command.trim());

  assert.ok(
    unitCommands.includes(
      "node --test scripts/tests/api-codegen-workflow-contract.test.mjs",
    ),
    "the root test:unit script must run the API codegen workflow contract suite",
  );
});

function createGeneratedClientFixture() {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "api-codegen-workflow-fixture-"),
  );

  try {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split("\0")
      .filter(Boolean);

    for (const file of files) {
      const source = path.join(workspaceRoot, file);
      const destination = path.join(fixtureRoot, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }

    symlinkSync(
      path.join(workspaceRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    for (const packagePath of [
      "lib/api-client-react",
      "lib/api-spec",
      "lib/api-zod",
    ]) {
      symlinkSync(
        path.join(workspaceRoot, packagePath, "node_modules"),
        path.join(fixtureRoot, packagePath, "node_modules"),
        "dir",
      );
    }

    return fixtureRoot;
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function runRootValidation(fixtureRoot) {
  try {
    return {
      status: 0,
      output: execFileSync("pnpm", ["validate:api-codegen"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        timeout: 240_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

test("root unit validation invokes the maintained API compatibility behavior suite", () => {
  const unitCommands = String(rootPackage.scripts?.["test:unit"] ?? "")
    .split("&&")
    .map((command) => command.trim());
  const compatibilityCommand =
    "pnpm --filter @workspace/api-spec run test:compatibility";

  assert.ok(
    unitCommands.includes(compatibilityCommand),
    "the root test:unit script must invoke the API specification package's maintained compatibility behavior suite",
  );
  assert.equal(
    resolveApiSpecPackageScript(compatibilityCommand),
    apiSpecPackage.scripts?.["test:compatibility"],
    "the root unit command must resolve the named API specification package script",
  );
});

test("root API codegen validation fails when the generated client drifts", () => {
  const originalGeneratedClient = readFileSync(
    path.join(workspaceRoot, generatedClientFixturePath),
  );
  let fixtureRoot;

  try {
    fixtureRoot = createGeneratedClientFixture();
    const fixtureGeneratedClient = path.join(
      fixtureRoot,
      generatedClientFixturePath,
    );
    appendFileSync(
      fixtureGeneratedClient,
      "\n// deterministic stale fixture\n",
    );

    const result = runRootValidation(fixtureRoot);

    assert.notEqual(
      result.status,
      0,
      "the root validation command must fail when generated output drifts",
    );
    assert.match(
      result.output,
      /Generated API drift detected after regeneration:/,
    );
    assert.match(
      result.output,
      /Run `pnpm --filter @workspace\/api-spec run codegen` and commit the generated output\./,
    );
    assert.deepEqual(
      readFileSync(fixtureGeneratedClient),
      Buffer.concat([
        originalGeneratedClient,
        Buffer.from("\n// deterministic stale fixture\n"),
      ]),
      "the checker must restore the changed fixture after reporting drift",
    );
    assert.deepEqual(
      readFileSync(path.join(workspaceRoot, generatedClientFixturePath)),
      originalGeneratedClient,
      "the repository checkout must remain unchanged",
    );
  } finally {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("generated-client drift evidence remains visible in the CI job log", () => {
  assert.ok(
    generatedClientStep,
    "expected the API codegen workflow to contain the generated-client validation step",
  );

  assert.equal(
    resolveRootPackageScript(generatedClientStep.run),
    "pnpm --filter @workspace/api-spec run check-generated",
    "the generated-client workflow must invoke the maintained checker through the root validation script so checker stderr remains in the job log",
  );
  assert.equal(
    apiSpecPackage.scripts?.["check-generated"],
    "pnpm run test && node ./scripts/check-generated.mjs",
    "the generated-client validation script must run its contract tests before the checker",
  );
  assert.match(
    generatedCheckerSource,
    /console\.error\("Generated API drift detected after regeneration:"\)/,
    "the job log must retain the primary generated-client drift failure signal",
  );
  assert.match(
    generatedCheckerSource,
    /console\.error\(\s*`Run \\`\$\{regenerationCommand\}\\` and commit the generated output\.`\s*\)/,
    "the job log must retain the generated-client regeneration command when summary publishing is unavailable",
  );
});

test("generated-client drift evidence is complete in the reviewer-visible summary", () => {
  assert.match(
    generatedCheckerSource,
    /process\.env\.GITHUB_STEP_SUMMARY/,
    "the checker must publish drift evidence through GitHub's reviewer-visible step summary",
  );
  assert.match(
    generatedCheckerSource,
    /const fence = markdownFence\(report\)/,
    "the summary must fence generated content without allowing report text to escape the Markdown block",
  );
  assert.ok(
    generatedCheckerSource.includes(
      "Regenerate with \\`${regenerationCommand}\\` and commit the generated output.",
    ),
    "the summary must include the regeneration command reviewers need",
  );
  assert.match(
    generatedCheckerSource,
    /Generated API drift detected[\s\S]*regenerationCommand[\s\S]*report[\s\S]*fence/,
    "the summary must include the heading, command, bounded report, and closing fence",
  );
});

test("generated-client validation remains required for the workflow", () => {
  assert.ok(
    generatedClientStep,
    "expected the API codegen workflow to contain the generated-client validation step",
  );

  assert.ok(
    generatedClientStep["continue-on-error"] === undefined ||
      generatedClientStep["continue-on-error"] === false,
    "the generated-client validation step must fail the job when its checker exits nonzero; do not enable continue-on-error",
  );
  assert.equal(
    generatedClientStep.if,
    undefined,
    "the generated-client validation step must not be conditionally skipped",
  );

  const job = workflow.jobs?.["check-generated"];
  assert.ok(
    job,
    "expected the API codegen workflow to contain the check-generated job",
  );
  assert.ok(
    job["continue-on-error"] === undefined ||
      job["continue-on-error"] === false,
    "the generated-client job must fail the workflow when its checker exits nonzero; do not enable continue-on-error",
  );
});

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
      new RegExp(`\\bsteps\\.${stepId}\\.outcome\\s*==\\s*['"]success['"]`),
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
