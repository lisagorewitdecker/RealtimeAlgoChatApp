import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

// The GitHub-hosted macOS job is the only place the Mac setup script meets a
// real Xcode and Apple's bash 3.2 before the owner's Mac does. This contract
// keeps the job read-only (no registration, no token, no services) and keeps
// its verdict tied to the dry-run report checker and the release docs.

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowRelativePath =
  ".github/workflows/ios-runner-provisioning-real-macos.yml";
const workflowText = readFileSync(
  path.join(workspaceRoot, workflowRelativePath),
  "utf8",
);
const workflow = YAML.parse(workflowText, { uniqueKeys: true });
const modelWorkflow = YAML.parse(
  readFileSync(
    path.join(workspaceRoot, ".github/workflows/hook-lock-real-macos.yml"),
    "utf8",
  ),
);
const docsText = readFileSync(
  path.join(
    workspaceRoot,
    "artifacts/chat-app/docs/native-large-text-device-check.md",
  ),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
);
const scriptsPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "scripts/package.json"), "utf8"),
);

const jobId = "dry-run-on-hosted-mac";
const job = workflow.jobs?.[jobId];
const steps = job?.steps ?? [];
const runSteps = steps.filter((step) => typeof step.run === "string");
const provisionScript = "scripts/provision-ios-runner.sh";
const harness = "scripts/tests/provision-ios-runner.test.sh";
const checker = "scripts/check-ios-runner-dry-run-report.sh";
const checkerTest = "scripts/tests/check-ios-runner-dry-run-report.test.sh";
const triggerPaths = [
  workflowRelativePath,
  provisionScript,
  "scripts/ios-runner-contract.sh",
  checker,
  "scripts/workflow-output-safety.sh",
  "scripts/run-untrusted-checker.sh",
  harness,
  checkerTest,
];

function stepRunning(fragment) {
  const step = runSteps.find((candidate) => candidate.run.includes(fragment));
  assert.ok(step, `expected a run step containing ${fragment}`);
  return step;
}

test("the job runs on a GitHub-hosted Mac for the provisioning inputs, weekly, and on demand", () => {
  assert.ok(job, `expected ${workflowRelativePath} to define the ${jobId} job`);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.equal(job["runs-on"], "macos-latest");
  assert.ok(
    Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] <= 30,
    "the dry run must be bounded by a short job timeout",
  );
  assert.equal(job.environment, undefined, "no deployment environment (and none of its secrets) may be attached");

  const triggers = workflow.on;
  assert.deepEqual(triggers.pull_request.branches, ["main"]);
  assert.deepEqual(triggers.push.branches, ["main"]);
  for (const trigger of [triggers.pull_request, triggers.push]) {
    assert.deepEqual(
      [...trigger.paths].sort(),
      [...triggerPaths].sort(),
      "every file the job exercises must trigger it, and nothing else",
    );
  }
  assert.ok(
    Array.isArray(triggers.schedule) &&
      triggers.schedule.some((entry) => /^\S+ \S+ \* \* \S+$/.test(entry.cron)),
    "a weekly schedule catches macos-latest image changes between edits",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(triggers, "workflow_dispatch"),
    "the job must be runnable on demand",
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency?.["cancel-in-progress"], true);
});

test("the job never registers a runner, reads a token, or installs services", () => {
  assert.ok(!workflowText.includes("secrets."), "no secret may reach the dry run");
  for (const forbidden of [
    "config.sh",
    "svc.sh",
    "--install-candidate",
    "--check-github",
    "gh auth",
    "RUNNER_TOKEN:",
    "ACTIONS_RUNNER_INPUT_TOKEN",
  ]) {
    assert.ok(
      !workflowText.includes(forbidden),
      `the hosted job must not contain ${forbidden}`,
    );
  }
  const dryRunStep = stepRunning(`./${provisionScript} --dry-run --no-github`);
  assert.match(
    dryRunStep.run,
    /provision-ios-runner\.sh --dry-run --no-github <\/dev\/null/,
    "the dry run must run non-interactively so no hidden token prompt can wait",
  );
  assert.match(dryRunStep.run, /unset RUNNER_TOKEN/);
  assert.equal(dryRunStep.env?.RUNNER_NAME, "ios-release-mac");
  assert.match(
    String(dryRunStep.env?.RUNNER_ROOT ?? ""),
    /^\$\{\{ runner\.temp \}\}\//,
    "the dry run must plan against an empty runner root under the job's temp directory",
  );
  assert.ok(
    !steps.some((step) => String(step.uses ?? "").includes("setup-node")),
    "the job needs only the preinstalled Node.js for the untrusted-output guard",
  );
});

test("the harness, the dry run, and the report check run under Apple's /bin/bash", () => {
  assert.equal(job.env?.PROVISION_TEST_BASH, "/bin/bash");
  const harnessStep = stepRunning(harness);
  assert.match(
    harnessStep.run,
    new RegExp(`run-untrusted-checker\\.sh /bin/bash ${harness.replaceAll(".", "\\.")}`),
  );
  assert.match(
    harnessStep.run,
    new RegExp(`run-untrusted-checker\\.sh /bin/bash ${checkerTest.replaceAll(".", "\\.")}`),
  );
  const dryRunStep = stepRunning(`./${provisionScript} --dry-run --no-github`);
  assert.match(dryRunStep.run, /run-untrusted-checker\.sh \/bin\/bash -o pipefail -c/);
  assert.match(dryRunStep.run, /\/bin\/bash \.\/scripts\/provision-ios-runner\.sh --dry-run/);
  assert.match(dryRunStep.run, /tee "\$1"/, "the transcript must be captured for the report check");

  const checkStep = stepRunning(checker);
  assert.equal(
    checkStep.if,
    "${{ !cancelled() }}",
    "the report check must run (and quote the transcript) even when the dry run step failed",
  );
  assert.match(
    checkStep.run,
    /\/bin\/bash scripts\/check-ios-runner-dry-run-report\.sh "\$DRY_RUN_TRANSCRIPT" --summary "\$GITHUB_STEP_SUMMARY"/,
  );
  assert.equal(checkStep.env?.DRY_RUN_TRANSCRIPT, dryRunStep.env?.DRY_RUN_TRANSCRIPT);
  assert.equal(steps.indexOf(checkStep), steps.length - 1);
  assert.ok(steps.indexOf(harnessStep) < steps.indexOf(dryRunStep));
});

test("the checkout action is pinned like the other real-macOS job", () => {
  const checkout = steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  const modelCheckout = modelWorkflow.jobs["verify-hook-lock-recovery"].steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.ok(checkout && modelCheckout);
  assert.match(String(checkout.uses), /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.uses, modelCheckout.uses);
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(checkout.with?.["fetch-depth"], 1);
});

test("the report checker and its test are wired into the Linux suites", () => {
  const iosRunnerCommand = String(scriptsPackage.scripts?.["test:ios-runner"] ?? "");
  assert.ok(
    iosRunnerCommand.includes("./tests/provision-ios-runner.test.sh") &&
      iosRunnerCommand.includes("./tests/check-ios-runner-dry-run-report.test.sh"),
    "test:ios-runner must run the harness and the report checker test",
  );
  const unitCommands = String(rootPackage.scripts?.["test:unit"] ?? "")
    .split("&&")
    .map((command) => command.trim());
  assert.ok(
    unitCommands.includes("pnpm --filter @workspace/scripts run test:ios-runner"),
    "test:unit must run the iOS runner suites",
  );
  assert.ok(
    unitCommands.includes(
      "node --test scripts/tests/ios-runner-real-macos-workflow.test.mjs",
    ),
    "test:unit must run this workflow contract",
  );
  assert.ok(
    unitCommands.includes("pnpm run validate:github-workflows"),
    "the workflow lint must cover the new workflow file",
  );
});

test("the release docs describe the hosted Mac check next to the other release checks", () => {
  for (const fragment of [
    workflowRelativePath,
    "iOS runner provisioning real macOS",
    checker,
    "--dry-run --no-github",
    "IOS_RUNNER_DRY_RUN_CHECK=",
    "PROVISION_TEST_BASH=/bin/bash",
  ]) {
    assert.ok(
      docsText.includes(fragment),
      `expected the device-check docs to mention ${fragment}`,
    );
  }
});
