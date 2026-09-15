import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import semver from "semver";
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

function parseNodeVersion(value, description) {
  const text = String(value).trim();
  const concrete = semver.valid(text);
  if (concrete) {
    return concrete;
  }

  const match = text
    .trim()
    .match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  assert.ok(
    match,
    `${description} must be a concrete Node major/minor/patch version, got ${JSON.stringify(value)}`,
  );
  assert.ok(
    !(match[2] === undefined && match[3] !== undefined),
    `${description} must be a concrete Node major/minor/patch version, got ${JSON.stringify(value)}`,
  );
  return `${match[1]}.${match[2] && !/^[x*]$/i.test(match[2]) ? match[2] : 0}.${match[3] && !/^[x*]$/i.test(match[3]) ? match[3] : 0}`;
}

function nodeVersionSatisfiesRange(version, range) {
  const candidate = parseNodeVersion(version, "configured Node version");
  assert.ok(
    semver.validRange(String(range)),
    `package.json engines.node contains an unsupported range: ${JSON.stringify(range)}`,
  );
  return semver.satisfies(candidate, String(range));
}

test("Node engine range validation accepts standard range forms", () => {
  const cases = [
    ["^24.0.0", "24.99.0", true],
    ["^24.0.0", "25.0.0", false],
    ["~24.2.0", "24.2.9", true],
    ["~24.2.0", "24.3.0", false],
    ["24.x", "24.99.0", true],
    ["24.x", "25.0.0", false],
    ["24.2.*", "24.2.9", true],
    ["24.2.*", "24.3.0", false],
    ["24.2 - 24.4", "24.4.99", true],
    ["24.2 - 24.4", "24.5.0", false],
    ["^0.2.3", "0.2.99", true],
    ["^0.2.3", "0.3.0", false],
    [">= 24 < 25", "24.5.0", true],
    [">= 24 < 25", "25.0.0", false],
    ["* >=24", "24.0.0", true],
    ["* >=24", "23.99.0", false],
    [">=1.2.3-beta.1 <1.2.3", "1.2.3-beta.2", true],
    [">=1.2.3-beta.1 <1.2.3", "1.2.3", false],
    ["1.2.3+build.7", "1.2.3+other-build", true],
  ];

  for (const [range, version, expected] of cases) {
    assert.equal(
      nodeVersionSatisfiesRange(version, range),
      expected,
      `${version} should ${expected ? "" : "not "}satisfy ${range}`,
    );
  }
});

test("Node engine range validation rejects malformed and unsupported syntax", () => {
  const invalidRanges = [
    ">= 24 <",
    "24.0.0.0",
    "latest",
  ];

  for (const range of invalidRanges) {
    assert.throws(
      () => nodeVersionSatisfiesRange("24.0.0", range),
      (error) => {
        assert.match(
          error.message,
          /package\.json engines\.node contains an unsupported range:/,
          "the failure must identify package.json engines.node",
        );
        assert.ok(
          error.message.includes(JSON.stringify(range)),
          `the failure must identify the offending range ${JSON.stringify(range)}`,
        );
        return true;
      },
      `the invalid range ${JSON.stringify(range)} must be rejected`,
    );
  }
});

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

function assertMobileReleaseNodeVersions(releaseWorkflow, nodeRange) {
  const configuredJobs = [];
  const mismatches = [];
  for (const [jobId, job] of Object.entries(releaseWorkflow.jobs ?? {})) {
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
    if (!nodeVersionSatisfiesRange(configuredVersion, nodeRange)) {
      mismatches.push(
        `mobile-release job "${jobId}" configures Node ${JSON.stringify(configuredVersion)}, outside package.json engines.node range ${JSON.stringify(nodeRange)}`,
      );
    }
  }
  assert.equal(mismatches.length, 0, mismatches.join("\n"));
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
  const actualSecrets = Object.keys(
    workflow.on.workflow_call.secrets ?? {},
  ).sort();
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

  assertMobileReleaseNodeVersions(workflow, nodeRange);
});

test("out-of-range mobile release Node diagnostics identify every job and version", () => {
  const fixture = structuredClone(workflow);
  const nodeRange = rootPackage.engines.node;
  const mismatches = [
    ["native-ios", "23"],
    ["native-android", "22"],
  ];
  for (const [jobId, configuredVersion] of mismatches) {
    const setupNodeStep = fixture.jobs[jobId].steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/setup-node@"),
    );
    assert.ok(
      setupNodeStep,
      `${jobId} fixture must configure Node with actions/setup-node`,
    );
    setupNodeStep.with["node-version"] = configuredVersion;
  }

  assert.throws(
    () => assertMobileReleaseNodeVersions(fixture, nodeRange),
    (error) => {
      for (const [jobId, configuredVersion] of mismatches) {
        assert.ok(
          error.message.includes(`mobile-release job "${jobId}"`),
          `the failure must identify the mobile release job ${jobId}`,
        );
        assert.ok(
          error.message.includes(`Node ${JSON.stringify(configuredVersion)}`),
          `the failure must identify the configured Node version for ${jobId}`,
        );
      }
      assert.ok(
        error.message.includes(
          `package.json engines.node range ${JSON.stringify(nodeRange)}`,
        ),
        "the failure must identify the package.json Node range",
      );
      return true;
    },
  );
});

test("missing mobile release Node versions identify the affected job and required configuration", () => {
  const fixture = structuredClone(workflow);
  const nodeRange = rootPackage.engines.node;
  const jobId = "native-ios";
  const setupNodeStep = fixture.jobs[jobId].steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/setup-node@"),
  );
  assert.ok(
    setupNodeStep,
    `${jobId} fixture must configure Node with actions/setup-node`,
  );
  delete setupNodeStep.with["node-version"];

  assert.throws(
    () => assertMobileReleaseNodeVersions(fixture, nodeRange),
    (error) => {
      assert.ok(
        error.message.includes(`mobile-release job "${jobId}"`),
        "the failure must identify the mobile release job",
      );
      assert.ok(
        error.message.includes("must configure node-version"),
        "the failure must explain that node-version is required",
      );
      return true;
    },
  );
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

test("Android preview evidence validation succeeds when no handoff record changed", () => {
  const evidenceStep = workflow.jobs?.["android-preview-evidence"]?.steps?.find(
    (step) => step.name === "Validate changed Android preview records",
  );
  assert.ok(evidenceStep, "the Android preview evidence validation step must exist");
  assert.match(
    evidenceStep.run,
    /Status: \*\*SKIP\*\*/,
    "zero changed records must be reported as skipped",
  );
  assert.match(
    evidenceStep.run,
    /No Android preview validation records changed; nothing to validate\./,
    "zero changed records must explain why validation did not run",
  );
  assert.match(
    evidenceStep.run,
    /exit 0/,
    "zero changed records must exit successfully",
  );
});

test("Android preview evidence runs for every pull request", () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "pull_request"),
    "mobile release workflow must support pull_request",
  );
  const pullRequest = workflow.on.pull_request ?? {};
  assert.equal(
    pullRequest.paths,
    undefined,
    "the required Android preview evidence check must not use a pull_request paths filter",
  );
  assert.equal(
    pullRequest["paths-ignore"],
    undefined,
    "the required Android preview evidence check must not use a pull_request paths-ignore filter",
  );

  const evidenceJob = workflow.jobs?.["android-preview-evidence"];
  assert.equal(
    evidenceJob?.name,
    "Android preview evidence",
    "the required status-check context must remain aligned with the evidence job name",
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
