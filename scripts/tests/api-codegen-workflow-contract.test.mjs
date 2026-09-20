import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
const driftPublishWorkflow = YAML.parse(
  readFileSync(
    path.join(workspaceRoot, ".github/workflows/api-codegen-drift-check.yml"),
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
// The checker and the check-run publisher render the reviewer-visible evidence
// through this shared module, so the contract is followed one import hop.
const generatedDriftReportSource = readFileSync(
  path.join(workspaceRoot, "lib/api-spec/scripts/generated-drift-report.mjs"),
  "utf8",
);
const driftSummarySource = readFileSync(
  path.join(workspaceRoot, "lib/api-spec/scripts/drift-summary.mjs"),
  "utf8",
);
const driftPublisherSource = readFileSync(
  path.join(workspaceRoot, "lib/api-spec/scripts/publish-drift-check.mjs"),
  "utf8",
);

const steps = workflow.jobs?.["check-generated"]?.steps ?? [];
const generatedClientStep = steps.find(
  (step) => step.name === "Verify generated API clients",
);
const compatibilityStep = steps.find(
  (step) => step.name === "Check API contract compatibility",
);
const driftEvidenceStep = steps.find(
  (step) => step.name === "Publish generated-client drift evidence",
);
const generatedClientFixturePath = "lib/api-client-react/src/generated/api.ts";
const pushTrigger = workflow.on?.push;
const pullRequestTrigger = workflow.on?.pull_request;
const generatedClientValidationFixturePaths = [
  "package.json",
  "pnpm-workspace.yaml",
  "replit.md",
  ".gitignore",
  ".githooks/pre-commit",
  "tsconfig.base.json",
  "tsconfig.json",
  ".github/pull_request_template.md",
  ".github/workflows/api-codegen.yml",
  "lib/api-spec",
  "lib/api-client-react/package.json",
  "lib/api-client-react/tsconfig.json",
  "lib/api-client-react/src",
  "lib/api-zod/package.json",
  "lib/api-zod/tsconfig.json",
  "lib/api-zod/src",
  "lib/db/package.json",
  "lib/db/tsconfig.json",
  "lib/db/src",
  "lib/integrations-anthropic-ai/package.json",
  "lib/integrations-anthropic-ai/tsconfig.json",
  "lib/integrations-anthropic-ai/src",
];

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

test("API codegen workflow runs after pushes to development", () => {
  assert.ok(pushTrigger, "the API codegen workflow must define a push trigger");
  assert.deepEqual(
    pushTrigger.branches,
    ["development"],
    "the API codegen workflow push trigger must target the development branch",
  );
});

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

test("API codegen workflow checks out full history for generated-client validation", () => {
  const checkoutStep = steps.find((step) => step.id === "checkout");

  assert.ok(
    checkoutStep,
    "the API codegen workflow must keep a checkout step because full history is required for generated-client validation",
  );
  assert.equal(
    checkoutStep.uses,
    "actions/checkout@v4",
    "the API codegen workflow checkout step must use actions/checkout",
  );
  assert.equal(
    checkoutStep.with?.ref,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    "the API codegen workflow checkout must use the submitted pull request head so fork reports describe the revision being reviewed instead of a synthetic merge ref",
  );
  assert.equal(
    checkoutStep.with?.["fetch-depth"],
    0,
    "the API codegen workflow checkout must use fetch-depth: 0 because full history is required for generated-client validation",
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

test("post-merge compatibility skips safely without pull request metadata", () => {
  assert.ok(
    compatibilityStep,
    "expected the API codegen workflow to contain the compatibility step",
  );

  const childEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: "push",
  };
  for (const key of [
    "API_BREAKING_CHANGE_JUSTIFICATION",
    "API_BREAKING_CHANGE_MIGRATION_PLAN",
    "API_BREAKING_CHANGE_PR_BODY",
    "GITHUB_STEP_SUMMARY",
  ]) {
    delete childEnv[key];
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(
        workspaceRoot,
        "lib/api-spec/scripts/check-contract-compatibility.mjs",
      ),
      "--baseline-file",
      "/missing/api-baseline.yaml",
      "--current-file",
      "/missing/api-current.yaml",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: childEnv,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(
    result.status,
    0,
    [
      "push compatibility validation must remain successful without pull request metadata",
      output,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  assert.match(
    output,
    /API contract compatibility enforcement is skipped on push events because breaking changes are reviewed and enforced on the pull request before merge\./,
    "push compatibility validation must explain that pull request enforcement already happened before merge",
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
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...generatedClientValidationFixturePaths,
      ],
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

    const mirrorNodeModules = (relativePath) => {
      const source = path.join(workspaceRoot, relativePath, "node_modules");
      if (!existsSync(source)) {
        return;
      }
      const destination = path.join(fixtureRoot, relativePath, "node_modules");
      mkdirSync(destination, { recursive: true });

      const linkEntry = (sourceEntry, fixtureEntry) => {
        const sourceStats = lstatSync(sourceEntry);
        if (path.basename(sourceEntry).startsWith(".pnpm-task-run-state")) {
          mkdirSync(fixtureEntry, { recursive: true });
          return;
        }
        if (
          path.basename(sourceEntry).startsWith("@") &&
          sourceStats.isDirectory()
        ) {
          mkdirSync(fixtureEntry, { recursive: true });
          for (const scopedEntry of readdirSync(sourceEntry)) {
            linkEntry(
              path.join(sourceEntry, scopedEntry),
              path.join(fixtureEntry, scopedEntry),
            );
          }
          return;
        }
        symlinkSync(
          sourceEntry,
          fixtureEntry,
          sourceStats.isDirectory() ? "dir" : "file",
        );
      };

      for (const entry of readdirSync(source)) {
        linkEntry(path.join(source, entry), path.join(destination, entry));
      }
    };

    mirrorNodeModules("");
    for (const packagePath of [
      "lib/api-client-react",
      "lib/api-spec",
      "lib/api-zod",
      "lib/db",
      "lib/integrations-anthropic-ai",
    ]) {
      mirrorNodeModules(packagePath);
    }

    return fixtureRoot;
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function runRootValidation(fixtureRoot) {
  const childEnv = { ...process.env };
  // Node's test runner adds NODE_TEST_CONTEXT to descendants. Without
  // clearing it, nested contract tests emit the runner's binary event stream
  // instead of their normal output and the fixture never reaches codegen.
  delete childEnv.NODE_TEST_CONTEXT;

  try {
    return {
      status: 0,
      output: execFileSync("pnpm", ["validate:api-codegen"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        timeout: 240_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
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
    /const driftReport = describeDrift\(before, after, differences\);\s*console\.error\(driftReport\)/,
    "the job log must emit the complete bounded generated-client drift report",
  );
  assert.match(
    generatedCheckerSource,
    /"Generated API drift detected after regeneration:"[\s\S]*`Run \\`\$\{regenerationCommand\}\\` and commit the generated output\.`/,
    "the bounded report fallback must retain the failure signal and regeneration command when detailed rendering is unavailable",
  );
  assert.match(
    generatedDriftReportSource,
    /Generated API drift detected after regeneration:/,
    "the job log must retain the primary generated-client drift failure signal",
  );
  assert.match(
    generatedDriftReportSource,
    /Run `pnpm --filter @workspace\/api-spec run codegen` and commit the generated output\./,
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
    /appendFileSync\(summaryPath, buildDriftSummary\(report\)\)/,
    "the checker must render the summary through the shared drift-summary module",
  );
  assert.match(
    driftSummarySource,
    /const fence = markdownFence\(report\)/,
    "the summary must fence generated content without allowing report text to escape the Markdown block",
  );
  assert.ok(
    driftSummarySource.includes(
      "Regenerate with \\`${regenerationCommand}\\` and commit the generated output.",
    ),
    "the summary must include the regeneration command reviewers need",
  );
  assert.match(
    driftSummarySource,
    /Generated API drift detected[\s\S]*regenerationCommand[\s\S]*report[\s\S]*fence/,
    "the summary must include the heading, command, bounded report, and closing fence",
  );
});

test("generated-client drift evidence is published where reviewers need no log access", () => {
  assert.equal(
    workflow.permissions?.checks,
    "write",
    "publishing the drift evidence as its own check run requires the checks write permission",
  );
  assert.ok(
    driftEvidenceStep,
    "expected the API codegen workflow to publish the generated-client drift evidence",
  );
  assert.equal(
    driftEvidenceStep.run,
    "node lib/api-spec/scripts/publish-drift-check.mjs",
    "the drift evidence must be published by the maintained publisher script",
  );
  assert.match(
    String(driftEvidenceStep.if),
    /steps\.verify-generated\.outcome == 'failure'/,
    "the evidence must be published exactly when the generated-client verification fails",
  );
  assert.equal(
    generatedClientStep?.id,
    "verify-generated",
    "the verification step must be identifiable so the publishing step can react to its outcome",
  );

  const reportPath = generatedClientStep?.env?.API_CODEGEN_DRIFT_REPORT_PATH;
  assert.ok(
    reportPath,
    "the verification step must tell the checker where to write the publishable drift report",
  );
  assert.equal(
    driftEvidenceStep.env?.API_CODEGEN_DRIFT_REPORT_PATH,
    reportPath,
    "the publishing step must read the same report the checker wrote; each step has its own step-summary file",
  );
  assert.ok(
    driftEvidenceStep.env?.GITHUB_TOKEN,
    "the publishing step needs a token to create the check run",
  );
  assert.match(
    String(driftEvidenceStep.env?.API_CODEGEN_DRIFT_HEAD_SHA),
    /pull_request\.head\.sha/,
    "the check run must be attached to the pull request head commit reviewers are looking at",
  );
  assert.equal(
    driftEvidenceStep.env?.API_CODEGEN_DRIFT_HEAD_SHA,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    "the published evidence must use the same fork-safe submitted revision as checkout, with a push fallback",
  );

  assert.match(
    generatedCheckerSource,
    /writeDriftReportFile\(driftReport\)/,
    "the checker must write the same bounded report it prints for publication",
  );
  assert.match(
    driftPublisherSource,
    /buildDriftSummary\(report, \{ limit: checkRunSummaryLimit \}\)/,
    "the published summary must use the shared rendering, bounded to GitHub's check-run limit",
  );
  assert.match(
    driftPublisherSource,
    /\/repos\/\$\{repository\}\/check-runs/,
    "the evidence must be published as a check run so it is readable without job-log access",
  );
});

test("generated-client drift artifacts are captured for the trusted follow-up publisher", () => {
  const uploadDriftArtifactStep = steps.find(
    (step) => step.name === "Upload generated-client drift artifact",
  );
  assert.ok(
    uploadDriftArtifactStep,
    "the API codegen workflow must upload drift evidence for the trusted follow-up publisher",
  );
  assert.equal(
    uploadDriftArtifactStep.uses,
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "the upload step must use the maintained upload-artifact action",
  );
  const condition = String(uploadDriftArtifactStep.if ?? "")
    .replace(/\$\{\{|\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.match(condition, /\bgithub\.event_name\s*==\s*'pull_request'/);
  assert.match(condition, /\bsteps\.verify-generated\.outcome\s*==\s*'failure'/);
  assert.equal(uploadDriftArtifactStep.with?.["if-no-files-found"], "ignore");
});

test("generated-client drift publication runs in the trusted workflow", () => {
  assert.deepEqual(
    driftPublishWorkflow.on?.workflow_run?.workflows,
    ["API generated clients"],
  );
  assert.deepEqual(driftPublishWorkflow.on?.workflow_run?.types, ["completed"]);
  assert.equal(driftPublishWorkflow.permissions?.actions, "read");
  assert.equal(driftPublishWorkflow.permissions?.checks, "write");
  assert.equal(driftPublishWorkflow.permissions?.contents, "read");

  const publishJob = driftPublishWorkflow.jobs?.["publish-generated-client-drift"];
  assert.ok(publishJob, "expected the trusted drift-publication job to exist");
  const publishSteps = publishJob.steps ?? [];
  const checkoutStep = publishSteps.find(
    (step) => step.name === "Check out trusted repository code",
  );
  const downloadStep = publishSteps.find(
    (step) => step.name === "Download generated-client drift artifact",
  );
  const publishStep = publishSteps.find(
    (step) => step.name === "Publish generated-client drift evidence",
  );

  assert.equal(checkoutStep?.uses, "actions/checkout@v5");
  assert.equal(
    downloadStep?.uses,
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  );
  assert.equal(downloadStep?.with?.["run-id"], "${{ github.event.workflow_run.id }}");
  assert.equal(
    publishStep?.run,
    "node lib/api-spec/scripts/publish-drift-check.mjs",
  );
  assert.equal(
    publishStep?.env?.API_CODEGEN_DRIFT_HEAD_SHA,
    "${{ github.event.workflow_run.head_sha }}",
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
