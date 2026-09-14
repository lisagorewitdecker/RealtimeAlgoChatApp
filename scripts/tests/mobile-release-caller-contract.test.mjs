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
    path.join(workspaceRoot, ".github/workflows/mobile-release.yml"),
    "utf8",
  ),
);
const callerDocumentation = readFileSync(
  path.join(
    workspaceRoot,
    "artifacts/chat-app/docs/native-large-text-device-check.md",
  ),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
);

const buildIdInputs = [
  "native_smoke_android_build_id",
  "native_smoke_ios_build_id",
];
const releaseCredentialSecrets = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
  "E2E_API_URL",
  "E2E_CHAT_URL",
  "EAS_TOKEN",
  "NATIVE_SMOKE_ANDROID_APP_ID",
  "NATIVE_SMOKE_ANDROID_SENTRY_DIST",
  "NATIVE_SMOKE_ANDROID_SENTRY_RELEASE",
  "NATIVE_SMOKE_DISPLAY_NAME",
  "NATIVE_SMOKE_EMAIL",
  "NATIVE_SMOKE_IOS_APP_ID",
  "NATIVE_SMOKE_IOS_SENTRY_DIST",
  "NATIVE_SMOKE_IOS_SENTRY_RELEASE",
  "NATIVE_SMOKE_PASSWORD",
  "SENTRY_AUTH_TOKEN",
];

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function parseNodeVersion(value, description) {
  const match = String(value)
    .trim()
    .match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  assert.ok(
    match,
    `${description} must be a concrete Node major/minor/patch version, got ${JSON.stringify(value)}`,
  );
  return {
    major: Number(match[1]),
    minor: match[2] && !/^[x*]$/i.test(match[2]) ? Number(match[2]) : 0,
    patch: match[3] && !/^[x*]$/i.test(match[3]) ? Number(match[3]) : 0,
  };
}

function nodeVersionSatisfiesRange(version, range) {
  const candidate = parseNodeVersion(version, "configured Node version");
  return String(range)
    .split("||")
    .some((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => {
          const match = comparator.match(/^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/);
          assert.ok(
            match,
            `package.json engines.node contains an unsupported comparator: ${JSON.stringify(comparator)}`,
          );
          const expected = parseNodeVersion(
            match[2],
            "package.json engines.node comparator",
          );
          const comparison = compareVersions(candidate, expected);
          switch (match[1] ?? "=") {
            case ">=":
              return comparison >= 0;
            case "<=":
              return comparison <= 0;
            case ">":
              return comparison > 0;
            case "<":
              return comparison < 0;
            case "=":
              return comparison === 0;
            default:
              return false;
          }
        }),
    );
}

function documentedCallerJob() {
  const section = callerDocumentation.match(
    /### Updating reusable-workflow callers[\s\S]*?```yaml\n([\s\S]*?)\n```/,
  );
  assert.ok(
    section,
    "the reusable-workflow caller documentation must include its YAML example",
  );

  const example = YAML.parse(section[1]);
  const jobs = Object.values(example?.jobs ?? {});
  assert.equal(
    jobs.length,
    1,
    "the documented reusable-workflow example must contain exactly one job",
  );
  return jobs[0];
}

test("documented caller passes every required build ID through with", () => {
  const workflowCall = workflow.on?.workflow_call;
  assert.ok(workflowCall, "mobile release workflow must support workflow_call");

  const requiredInputs = Object.entries(workflowCall.inputs ?? {})
    .filter(([, input]) => input.required === true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    requiredInputs,
    buildIdInputs,
    "workflow_call required inputs must remain the two candidate build IDs",
  );

  const callerJob = documentedCallerJob();
  assert.deepEqual(
    Object.keys(callerJob.with ?? {}).sort(),
    requiredInputs,
    "the documented caller's with mapping must match every required workflow_call input",
  );
  for (const input of requiredInputs) {
    assert.match(
      String(callerJob.with[input]),
      /^\$\{\{\s*vars\.[A-Z0-9_]+\s*\}\}$/,
      `${input} must be passed from non-secret caller configuration`,
    );
  }
});

test("candidate build IDs do not cross the reusable secrets boundary", () => {
  const workflowSecrets = workflow.on.workflow_call.secrets ?? {};
  const callerJob = documentedCallerJob();

  assert.equal(
    callerJob.secrets,
    "inherit",
    "the documented caller must preserve the reusable workflow's credential contract",
  );
  for (const input of buildIdInputs) {
    assert.equal(
      workflowSecrets[input],
      undefined,
      `${input} must be declared as an input, not a workflow_call secret`,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(callerJob.secrets),
    /NATIVE_SMOKE_(?:IOS|ANDROID)_BUILD_ID/,
    "the documented caller must not pass candidate build IDs through secrets",
  );
});

test("release credentials remain in the reusable workflow secrets contract", () => {
  const actualSecrets = Object.keys(workflow.on.workflow_call.secrets ?? {}).sort();
  assert.deepEqual(
    actualSecrets,
    releaseCredentialSecrets,
    "credential, account, Sentry, Clerk, URL, and database values must remain workflow_call secrets",
  );

  for (const secret of releaseCredentialSecrets) {
    const contract = workflow.on.workflow_call.secrets[secret];
    assert.equal(
      contract.required,
      secret !== "NATIVE_SMOKE_DISPLAY_NAME",
      `${secret} has an unexpected workflow_call required setting`,
    );
  }
});

test("every mobile release setup-node value stays inside the declared Node range", () => {
  const nodeRange = rootPackage.engines?.node;
  assert.equal(
    typeof nodeRange,
    "string",
    "package.json must declare engines.node for mobile release validation",
  );

  const configuredJobs = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? "").startsWith("actions/setup-node@")) {
        configuredJobs.push({
          jobId,
          configuredVersion: step.with?.["node-version"],
        });
      }
    }
  }

  assert.ok(
    configuredJobs.length > 0,
    "mobile-release.yml must configure Node with actions/setup-node",
  );
  for (const { jobId, configuredVersion } of configuredJobs) {
    assert.ok(
      configuredVersion !== undefined,
      `mobile-release job "${jobId}" must configure node-version`,
    );
    assert.ok(
      nodeVersionSatisfiesRange(configuredVersion, nodeRange),
      `mobile-release job "${jobId}" configures Node ${JSON.stringify(configuredVersion)}, outside package.json engines.node range ${JSON.stringify(nodeRange)}`,
    );
  }
});

test("publish job runs the privacy regression before approval validation and submission", () => {
  const publishSteps = workflow.jobs?.["mobile-publish"]?.steps ?? [];
  const privacyIndex = publishSteps.findIndex(
    (step) => step.name === "Run native large-text evidence privacy regression",
  );
  const approvalValidationIndex = publishSteps.findIndex(
    (step) => step.name === "Require approved iOS and Android evidence",
  );
  const submissionIndex = publishSteps.findIndex(
    (step) => step.name === "Submit the tested iOS and Android candidates",
  );

  assert.ok(
    privacyIndex >= 0,
    "mobile-publish must run the native evidence privacy regression",
  );
  assert.equal(
    publishSteps[privacyIndex].run,
    "pnpm run test:native-large-text-evidence",
    "mobile-publish must use the focused native evidence privacy regression command",
  );
  assert.ok(
    approvalValidationIndex >= 0,
    "mobile-publish must validate candidate approvals",
  );
  assert.ok(
    submissionIndex >= 0,
    "mobile-publish must submit the tested candidates",
  );
  assert.ok(
    privacyIndex < approvalValidationIndex,
    "privacy regression must run before candidate approval validation",
  );
  assert.ok(
    privacyIndex < submissionIndex,
    "privacy regression must run before store submission",
  );
});

test("routine unit validation runs the caller contract check", () => {
  const command =
    "node --test scripts/tests/mobile-release-caller-contract.test.mjs";
  const unitCommands = String(rootPackage.scripts?.["test:unit"] ?? "")
    .split("&&")
    .map((entry) => entry.trim());

  assert.ok(
    unitCommands.includes(command),
    "the root test:unit script must run the mobile release caller contract check",
  );
});