import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
const workflowRelativePath = ".github/workflows/root-contract-checks.yml";
const workflowText = readFileSync(
  path.join(workspaceRoot, workflowRelativePath),
  "utf8",
);
// A duplicate key is exactly the breakage this gate exists to catch, so the
// contract itself must never tolerate one in the gate's own workflow file.
const workflow = YAML.parse(workflowText, { uniqueKeys: true });
const modelWorkflow = YAML.parse(
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

// The repository ruleset for main requires a status check with exactly this
// context; GitHub derives it from the job's display name.
const requiredCheckContext = "Root contract checks";
const jobId = "root-contract-checks";
const job = workflow.jobs?.[jobId];
const steps = job?.steps ?? [];
const stepById = new Map(steps.map((step) => [step.id, step]));
const dependencyGuard =
  "${{ !cancelled() && steps.install-dependencies.outcome == 'success' }}";
const rootUnitCommands = String(rootPackage.scripts?.["test:unit"] ?? "")
  .split("&&")
  .map((command) => command.trim());

function modelStep(usesPrefix) {
  const step = modelWorkflow.jobs["check-generated"].steps.find((candidate) =>
    String(candidate.uses ?? "").startsWith(usesPrefix),
  );
  assert.ok(step, `expected api-codegen.yml to use ${usesPrefix}`);
  return step;
}

function assertPinnedAction(step, action) {
  const match = String(step.uses).match(/^([^@]+)@([0-9a-f]{40})$/);
  assert.ok(
    match,
    `expected ${step.id} to pin ${action} to a full commit SHA, received: ${step.uses}`,
  );
  assert.equal(match[1], action);
}

test("the root contract gate guards pull requests into main with read-only permissions", () => {
  assert.equal(workflow.name, requiredCheckContext);
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"] });
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group:
      "root-contract-checks-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": true,
  });

  assert.deepEqual(Object.keys(workflow.jobs), [jobId]);
  assert.equal(job.name, requiredCheckContext);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 30);
  // A matrix or job-level permissions would change the check context or widen
  // the token; neither belongs in a required merge gate.
  assert.equal(job.strategy, undefined);
  assert.equal(job.permissions, undefined);
  assert.equal(job.environment, undefined);
  for (const step of steps) {
    assert.equal(typeof step.id, "string", `every step needs an id: ${step.name}`);
    assert.equal(
      step["continue-on-error"],
      undefined,
      `${step.id} must not continue on error`,
    );
  }
});

test("the gate checks out the reviewed revision with pinned actions and no persisted credentials", () => {
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      "checkout",
      "install-system-tools",
      "setup-pnpm",
      "setup-node",
      "install-dependencies",
      "typecheck",
      "unit-tests",
      "api-codegen",
    ],
  );

  const checkout = stepById.get("checkout");
  assertPinnedAction(checkout, "actions/checkout");
  assert.deepEqual(checkout.with, { "fetch-depth": 0, "persist-credentials": false });

  const setupPnpm = stepById.get("setup-pnpm");
  assertPinnedAction(setupPnpm, "pnpm/action-setup");
  assert.deepEqual(setupPnpm.with, {
    version: modelStep("pnpm/action-setup@").with.version,
  });

  const setupNode = stepById.get("setup-node");
  assertPinnedAction(setupNode, "actions/setup-node");
  assert.deepEqual(setupNode.with, {
    "node-version": modelStep("actions/setup-node@").with["node-version"],
    cache: "pnpm",
  });

  for (const step of steps) {
    if (step.uses !== undefined) {
      assert.equal(step.run, undefined, `${step.id} mixes uses and run`);
    }
  }
});

test("the gate runs the root install, typecheck, unit, and API codegen commands", () => {
  assert.equal(
    stepById.get("install-dependencies").run,
    "pnpm install --frozen-lockfile",
  );
  assert.equal(stepById.get("install-dependencies").if, undefined);

  assert.equal(stepById.get("typecheck").run, "pnpm run typecheck");
  assert.equal(stepById.get("typecheck").if, undefined);
  assert.equal(typeof rootPackage.scripts?.typecheck, "string");

  // Later checks keep running after an earlier failure so one run reports
  // everything a pull request has to fix, but never on a broken install.
  assert.equal(stepById.get("unit-tests").run, "pnpm test:unit --run");
  assert.equal(stepById.get("unit-tests").if, dependencyGuard);
  assert.equal(typeof rootPackage.scripts?.["test:unit"], "string");

  assert.equal(
    stepById.get("api-codegen").run,
    "pnpm run validate:api-codegen",
  );
  assert.equal(stepById.get("api-codegen").if, dependencyGuard);
  assert.equal(
    rootPackage.scripts?.["validate:api-codegen"],
    "pnpm --filter @workspace/api-spec run check-generated",
  );
  assert.match(
    String(apiSpecPackage.scripts?.["check-generated"]),
    /node \.\/scripts\/check-generated\.mjs$/,
  );

  for (const step of steps) {
    if (step.run === undefined) {
      continue;
    }
    assert.equal(step.env, undefined, `${step.id} must not receive env values`);
    assert.equal(step.shell, undefined, `${step.id} must use the default shell`);
    assert.equal(
      step["working-directory"],
      undefined,
      `${step.id} must run from the workspace root`,
    );
  }
});

test("the gate's unit suite covers the breakages that reached main unchecked", () => {
  // Duplicate YAML keys and doubled steps in the mobile release workflow.
  assert.ok(rootUnitCommands.includes("pnpm run validate:mobile-release-workflow"));
  assert.match(
    String(rootPackage.scripts?.["validate:mobile-release-workflow"]),
    /^actionlint .*\.github\/workflows\/mobile-release\.yml$/,
  );
  assert.ok(
    rootUnitCommands.includes(
      "node --test scripts/tests/mobile-release-caller-contract.test.mjs",
    ),
  );

  // The production EthicalCheck job must not depend on an unavailable action.
  assert.ok(
    rootUnitCommands.includes(
      "node --test scripts/tests/ethicalcheck-workflow-contract.test.mjs",
    ),
  );

  // Bash syntax errors in the native large-text evidence checker.
  assert.ok(rootUnitCommands.includes("pnpm run test:native-large-text-evidence"));
  assert.equal(
    rootPackage.scripts?.["test:native-large-text-evidence"],
    "bash scripts/tests/check-native-large-text-evidence.test.sh",
  );

  // A redeclared const in the API compatibility test module.
  assert.ok(
    rootUnitCommands.includes(
      "pnpm --filter @workspace/api-spec run test:compatibility",
    ),
  );
  assert.equal(
    apiSpecPackage.scripts?.["test:compatibility"],
    "node ./scripts/check-contract-compatibility.test.mjs",
  );
});

test("a duplicate YAML key in the mobile release workflow fails the gate's lint readably", () => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "root-contract-checks-duplicate-key-"),
  );
  try {
    // actionlint reads the repository's self-hosted runner labels from
    // .github/actionlint.yaml in the project root it detects from the
    // workflow's nearest .git directory, so the fixture mirrors that layout.
    const fixtureWorkflowsDir = path.join(fixtureRoot, ".github/workflows");
    mkdirSync(fixtureWorkflowsDir, { recursive: true });
    mkdirSync(path.join(fixtureRoot, ".git"));
    copyFileSync(
      path.join(workspaceRoot, ".github/actionlint.yaml"),
      path.join(fixtureRoot, ".github/actionlint.yaml"),
    );
    const workflowSource = readFileSync(
      path.join(workspaceRoot, ".github/workflows/mobile-release.yml"),
      "utf8",
    );
    const fixturePath = path.join(fixtureWorkflowsDir, "mobile-release.yml");
    writeFileSync(fixturePath, `${workflowSource}\nname: duplicated name key\n`);

    const lint = spawnSync(
      "pnpm",
      ["exec", "actionlint", "-shellcheck=", "-oneline", fixturePath],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.equal(lint.status, 1, lint.stdout + lint.stderr);
    const findings = lint.stdout.trim().split("\n");
    assert.equal(findings.length, 1, lint.stdout);
    assert.match(
      findings[0],
      /mobile-release\.yml:\d+:1: key "name" is duplicated in "workflow" section\. previously defined at line:1,col:1 \[syntax-check\]$/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("the gate uses no secrets, tokens, or non-Linux runners", () => {
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /github\.token|GITHUB_TOKEN/);
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.doesNotMatch(workflowText, /runs-on:\s*.*(?:macos|windows)/i);
  assert.doesNotMatch(workflowText, /\b(publish|deploy|submit)\b/i);

  // The Android preview evidence tests need Tesseract and ImageMagick, which
  // GitHub's Ubuntu image does not ship; nothing else is installed system-wide.
  const systemTools = stepById.get("install-system-tools").run;
  assert.match(systemTools, /^set -euo pipefail$/m);
  assert.match(
    systemTools,
    /sudo apt-get install --no-install-recommends -y \\\n\s+fonts-dejavu-core imagemagick tesseract-ocr tesseract-ocr-eng\n/,
  );
  assert.match(systemTools, /tesseract --list-langs 2>\/dev\/null \| grep -Fxq "eng"/);
  assert.doesNotMatch(systemTools, /\b(curl|wget|pip3?|npm|npx|brew)\b/);
});

test("root unit validation runs the root contract gate workflow suite", () => {
  assert.ok(
    rootUnitCommands.includes(
      "node --test scripts/tests/root-contract-checks-workflow.test.mjs",
    ),
    "the root test:unit script must run the root contract gate workflow suite",
  );
});
