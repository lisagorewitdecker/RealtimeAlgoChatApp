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
const pinnedCheckoutAction =
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const pinnedSetupNodeAction =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
function resolveWorkflowEnvExpression(value, workflowEnv, jobEnv, stepEnv) {
  const match = String(value).trim().match(/^\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}$/);
  if (!match) {
    return value;
  }

  const [, name] = match;
  if (stepEnv?.[name] !== undefined) {
    return stepEnv[name];
  }
  if (jobEnv?.[name] !== undefined) {
    return jobEnv[name];
  }
  if (workflowEnv?.[name] !== undefined) {
    return workflowEnv[name];
  }
  return value;
}

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

function nodeVersionSatisfiesRange(
  version,
  range,
  description = "configured Node version",
) {
  const candidate = parseNodeVersion(version, description);
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

function documentedCallerSecrets() {
  const section = callerDocumentation.match(
    /#### Required reusable-workflow secrets\n([\s\S]*?)\n#### Optional reusable-workflow secrets\n([\s\S]*?)\n\nBuild each candidate with/,
  );
  assert.ok(
    section,
    "the caller setup documentation must separate required and optional reusable-workflow secrets",
  );

  const parseSecretList = (list, classification) => {
    const secrets = [...list.matchAll(/^- `([A-Z0-9_]+)`/gm)].map(
      ([, secret]) => secret,
    );
    assert.ok(
      secrets.length > 0,
      `the caller setup documentation must list ${classification} reusable-workflow secrets`,
    );
    return secrets.sort();
  };

  return {
    required: parseSecretList(section[1], "required"),
    optional: parseSecretList(section[2], "optional"),
  };
}

function assertMobileReleaseNodeVersions(releaseWorkflow, nodeRange) {
  const configuredJobs = [];
  const malformedVersions = [];
  const mismatches = [];
  for (const [jobId, job] of Object.entries(releaseWorkflow.jobs ?? {})) {
    if (jobId === "mobile-release-node-range") {
      continue;
    }
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? "").startsWith("actions/setup-node@")) {
        configuredJobs.push({
          jobId,
          configuredVersion: resolveWorkflowEnvExpression(
            step.with?.["node-version"],
            releaseWorkflow.env,
            job.env,
            step.env,
          ),
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
      `mobile-release job "${jobId}" must configure node-version; package.json engines.node range is ${JSON.stringify(
        nodeRange,
      )}`,
    );
    let satisfiesRange;
    try {
      satisfiesRange = nodeVersionSatisfiesRange(
        configuredVersion,
        nodeRange,
        `mobile-release job "${jobId}" node-version`,
      );
    } catch (error) {
      if (
        String(error.message).includes(
          "must be a concrete Node major/minor/patch version",
        )
      ) {
        malformedVersions.push(error.message);
        continue;
      }
      throw error;
    }
    if (!satisfiesRange) {
      mismatches.push(
        `mobile-release job "${jobId}" configures Node ${JSON.stringify(configuredVersion)}, outside package.json engines.node range ${JSON.stringify(nodeRange)}`,
      );
    }
  }
  assert.equal(malformedVersions.length, 0, malformedVersions.join("\n"));
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

test("controlled Node range validation input is optional and stays outside secrets", () => {
  const workflowDispatchInputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  const workflowCallInputs = workflow.on?.workflow_call?.inputs ?? {};
  for (const inputs of [workflowDispatchInputs, workflowCallInputs]) {
    assert.equal(
      inputs.node_range_override?.required,
      false,
      "controlled Node range validation must be opt-in",
    );
    assert.equal(
      inputs.node_range_override?.type,
      "string",
      "controlled Node range validation must accept an isolated string fixture",
    );
  }
  assert.equal(
    workflow.on.workflow_call.secrets?.node_range_override,
    undefined,
    "the controlled Node range fixture must not cross the reusable secrets boundary",
  );
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

test("caller setup documentation lists every reusable workflow secret with its required setting", () => {
  const workflowSecrets = workflow.on.workflow_call.secrets ?? {};
  const documentedSecrets = documentedCallerSecrets();
  const requiredSecrets = Object.entries(workflowSecrets)
    .filter(([, contract]) => contract.required === true)
    .map(([secret]) => secret)
    .sort();
  const optionalSecrets = Object.entries(workflowSecrets)
    .filter(([, contract]) => contract.required !== true)
    .map(([secret]) => secret)
    .sort();

  assert.deepEqual(
    documentedSecrets.required,
    requiredSecrets,
    "the documented required secrets must exactly match required workflow_call secrets",
  );
  assert.deepEqual(
    documentedSecrets.optional,
    optionalSecrets,
    "the documented optional secrets must exactly match optional workflow_call secrets",
  );
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

test("invalid Node range guard blocks release jobs before setup or publish work", () => {
  const guard = workflow.jobs?.["mobile-release-node-range"];
  assert.ok(guard, "mobile release must validate its Node range in a dedicated guard job");
  assert.match(
    guard.steps?.find((step) => step.name === "Read package.json Node range")?.run,
    /NODE_RANGE_OVERRIDE/,
    "the guard must support an isolated controlled range fixture",
  );
  const resolveStep = guard.steps?.find(
    (step) => step.name === "Resolve configured Node range",
  );
  assert.equal(
    resolveStep?.["continue-on-error"],
    true,
    "the resolver must continue so the guard can emit its actionable diagnostic",
  );
  assert.equal(
    resolveStep?.with?.["node-version"],
    "${{ steps.read-node-range.outputs.node_range }}",
    "the resolver must validate the selected package or fixture range",
  );
  const rejectStep = guard.steps?.find(
    (step) => step.name === "Reject invalid Node range before release checks",
  );
  assert.equal(
    rejectStep?.if,
    "${{ always() }}",
    "the invalid-range diagnostic must run after a resolver failure",
  );
  assert.match(
    rejectStep?.run,
    /package\.json engines\.node contains an unsupported range/,
    "the failure must identify package.json engines.node",
  );
  assert.match(
    rejectStep?.run,
    /NODE_RANGE/,
    "the failure must include the offending range",
  );
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (
      jobId === "mobile-release-node-range" ||
      jobId === "android-preview-evidence" ||
      jobId === "ios-preview-evidence" ||
      jobId === "mobile-publish"
    ) {
      continue;
    }
    if (job.if?.includes("github.event_name != 'pull_request'")) {
      assert.ok(
        (job.needs ?? []).includes("mobile-release-node-range"),
        `${jobId} must wait for the Node range guard before release work`,
      );
    }
  }
  assert.match(
    String(workflow.jobs?.["mobile-release-gate"]?.if),
    /needs\.mobile-release-node-range\.result == 'success'/,
    "the release gate must not start after the Node range guard fails",
  );
  assert.match(
    String(workflow.jobs?.["mobile-release-gate"]?.if),
    /needs\.mobile-release-configuration\.result == 'success'/,
    "the release gate must not start before mobile release configuration is evaluated",
  );
  assert.match(
    String(workflow.jobs?.["mobile-release-gate"]?.if),
    /needs\.idle-profile-registration\.result == 'success'/,
    "the release gate must only start after idle-profile registration succeeds",
  );
  assert.match(
    String(workflow.jobs?.["mobile-release-gate"]?.if),
    /needs\.native-evidence-summary-regression\.result == 'success'/,
    "the release gate must only start after hosted summary regression succeeds",
  );
  assert.doesNotMatch(
    String(workflow.jobs?.["mobile-release-gate"]?.if),
    /needs\.native-ios\.result == 'success'|needs\.native-android\.result == 'success'/,
    "the release gate must still run when native jobs are skipped for missing release configuration",
  );
  assert.doesNotMatch(
    rejectStep?.run,
    /secrets\./,
    "the invalid-range diagnostic must not read or expose release secrets",
  );
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

test("malformed mobile release Node versions identify the affected job and required format", () => {
  const fixture = structuredClone(workflow);
  const nodeRange = rootPackage.engines.node;
  const malformedValues = [
    ["native-ios", "24."],
    ["native-android", "lts"],
  ];

  for (const [jobId, configuredVersion] of malformedValues) {
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
      for (const [jobId, configuredVersion] of malformedValues) {
        assert.ok(
          error.message.includes(`mobile-release job "${jobId}"`),
          `the failure must identify the mobile release job ${jobId}`,
        );
        assert.ok(
          error.message.includes(
            "must be a concrete Node major/minor/patch version",
          ),
          "the failure must explain the required concrete Node version format",
        );
        assert.ok(
          error.message.includes(JSON.stringify(configuredVersion)),
          `the failure must identify the malformed Node version ${JSON.stringify(configuredVersion)}`,
        );
      }
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
      assert.ok(
        error.message.includes(
          `package.json engines.node range is ${JSON.stringify(nodeRange)}`,
        ),
        "the failure must identify the supported package.json Node range",
      );
      return true;
    },
  );
});

test("blocked release diagnostics identify the supported Node range safely", () => {
  const gateSteps = workflow.jobs?.["mobile-release-gate"]?.steps ?? [];
  const blockStep = gateSteps.find(
    (step) => step.name === "Block release unless both native checks pass",
  );
  assert.ok(
    blockStep,
    "mobile-release-gate must retain its final release-blocking step",
  );
  assert.match(
    blockStep.run,
    /Supported Node\.js range from package\.json engines\.node:/,
    "blocked release output must identify the supported package.json Node range",
  );
  assert.match(
    blockStep.run,
    /must be a valid semver range/,
    "blocked release output must explain how to fix a malformed Node range",
  );
  assert.match(
    blockStep.run,
    /JSON\.stringify\(configuredRange\.trim\(\)\)/,
    "the configured Node range must be escaped before it reaches the log",
  );
  assert.match(
    blockStep.run,
    /package\.json is not valid JSON/,
    "malformed package.json output must remain actionable",
  );
  assert.match(
    blockStep.run,
    /configuration=\$RELEASE_CONFIGURATION_RESULT/,
    "blocked release output must include the centralized configuration result",
  );
  assert.match(
    blockStep.run,
    /summary-regression=\$SUMMARY_REGRESSION_RESULT\./,
    "blocked release output must use the declared summary regression result",
  );
});

test("workflow hardening pins actions, runs for every pull request, and bounds duplicate release work", () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "pull_request"),
    "pull_request runs must stay enabled so the required Android preview evidence check is always created",
  );
  assert.equal(
    workflow.on?.pull_request?.paths,
    undefined,
    "pull_request runs must stay unscoped so the required Android preview evidence check is always created",
  );
  assert.equal(
    workflow.on?.pull_request?.["paths-ignore"],
    undefined,
    "the workflow should not use pull_request paths-ignore rules",
  );
  assert.equal(
    workflow.concurrency?.group,
    "mobile-release-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref || github.run_id }}",
    "duplicate mobile release runs must share a stable concurrency group",
  );
  assert.equal(
    workflow.concurrency?.["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
    "only pull request reruns should cancel earlier in-flight runs",
  );
  assert.equal(
    workflow.defaults?.run?.shell,
    "bash",
    "release workflow run steps must default to bash",
  );
  assert.equal(
    workflow.env?.RELEASE_NODE_VERSION,
    24,
    "release workflow must centralize its concrete Node version",
  );

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? "").startsWith("actions/checkout@")) {
        assert.equal(
          step.uses,
          pinnedCheckoutAction,
          `${jobId} must pin actions/checkout by commit SHA`,
        );
      }
      if (String(step.uses ?? "").startsWith("actions/setup-node@")) {
        assert.equal(
          step.uses,
          pinnedSetupNodeAction,
          `${jobId} must pin actions/setup-node by commit SHA`,
        );
      }
    }
  }

  assert.equal(
    workflow.jobs?.["android-prerequisite-preflight"]?.["timeout-minutes"],
    20,
    "Android release runner preflight must not wait indefinitely on self-hosted infrastructure",
  );
  assert.equal(
    workflow.jobs?.["native-ios"]?.["timeout-minutes"],
    90,
    "native-ios must have an explicit timeout",
  );
  assert.equal(
    workflow.jobs?.["native-android"]?.["timeout-minutes"],
    90,
    "native-android must have an explicit timeout",
  );
  assert.equal(
    workflow.jobs?.["idle-profile-registration"]?.["timeout-minutes"],
    20,
    "idle-profile-registration must have an explicit timeout",
  );
  assert.equal(
    workflow.jobs?.["mobile-publish"]?.["timeout-minutes"],
    45,
    "mobile-publish must have an explicit timeout",
  );
});

test("publish job runs the evidence privacy and submission-boundary regression before approval validation and submission", () => {
  const publishSteps = workflow.jobs?.["mobile-publish"]?.steps ?? [];
  const privacyIndex = publishSteps.findIndex(
    (step) =>
      step.name ===
      "Run native large-text evidence privacy and submission-boundary regression",
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
    /No Android preview validation records or preflight artifacts changed; nothing to validate\./,
    "zero changed records must explain why validation did not run",
  );
  assert.match(
    evidenceStep.run,
    /exit 0/,
    "zero changed records must exit successfully",
  );
});

test("iOS preview evidence validation succeeds when no handoff record changed", () => {
  const evidenceStep = workflow.jobs?.["ios-preview-evidence"]?.steps?.find(
    (step) => step.name === "Validate changed iOS preview records",
  );
  assert.ok(evidenceStep, "the iOS preview evidence validation step must exist");
  assert.match(
    evidenceStep.run,
    /Status: \*\*SKIP\*\*/,
    "zero changed records must be reported as skipped",
  );
  assert.match(
    evidenceStep.run,
    /No iOS preview validation records or preflight artifacts changed; nothing to validate\./,
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
  assert.equal(
    workflow.on.pull_request?.paths,
    undefined,
    "the Android preview evidence check must not use a pull_request path filter",
  );
  assert.equal(
    workflow.on.pull_request?.["paths-ignore"],
    undefined,
    "the Android preview evidence check must not use pull_request paths-ignore rules",
  );

  const evidenceJob = workflow.jobs?.["android-preview-evidence"];
  assert.equal(
    evidenceJob?.name,
    "Android preview evidence",
    "the required status-check context must remain aligned with the evidence job name",
  );
});

test("iOS preview evidence runs for every pull request", () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "pull_request"),
    "mobile release workflow must support pull_request",
  );
  assert.equal(
    workflow.on.pull_request?.paths,
    undefined,
    "the iOS preview evidence check must not use a pull_request path filter",
  );
  assert.equal(
    workflow.on.pull_request?.["paths-ignore"],
    undefined,
    "the iOS preview evidence check must not use pull_request paths-ignore rules",
  );

  const evidenceJob = workflow.jobs?.["ios-preview-evidence"];
  assert.equal(
    evidenceJob?.name,
    "iOS preview evidence",
    "the required status-check context must remain aligned with the evidence job name",
  );
  const evidenceStep = evidenceJob?.steps?.find(
    (step) => step.name === "Validate changed iOS preview records",
  );
  assert.ok(evidenceStep, "the iOS preview evidence job must validate changed records");
  assert.deepEqual(
    evidenceStep.env,
    {
      IOS_PREVIEW_BASE_SHA:
        "${{ github.event.pull_request.base.sha }}",
      IOS_PREVIEW_HEAD_SHA:
        "${{ github.event.pull_request.head.sha }}",
    },
    "the iOS preview job must compare the pull request base and head",
  );
  assert.match(
    evidenceStep.run,
    /git diff[\s\S]*--find-renames[\s\S]*--diff-filter=ACDMRT[\s\S]*\$\{IOS_PREVIEW_BASE_SHA\}\.\.\.\$\{IOS_PREVIEW_HEAD_SHA\}[\s\S]*artifacts\/chat-app\/test-results\/encrypted-room-recovery\/ios\/\*\*\/validation-record\.md[\s\S]*artifacts\/chat-app\/test-results\/encrypted-room-recovery\/ios\/\*\*\/ios-preview-preflight\.json/,
    "the job must select changed iOS validation records from the pull request diff",
  );
  assert.match(
    evidenceStep.run,
    /changed_preflight_paths[\s\S]*record_path="\$\{changed_path%\/ios-preview-preflight\.json\}\/validation-record\.md"/,
    "the job must map changed iOS preflight artifacts back to their validation records",
  );
  assert.match(
    evidenceStep.run,
    /pnpm run validate:ios-preview-evidence -- "\$\{checker_args\[@\]\}"/,
    "the job must run the focused iOS checker for every changed record",
  );
  assert.match(
    evidenceStep.run,
    /changed iOS preview validation record is missing/,
    "deleted or missing changed records must fail the job",
  );
  assert.match(
    evidenceStep.run,
    /BLOCKED \(valid physical-phone handoff unavailable\)/,
    "a valid physical-phone BLOCKED record must be distinguished in the summary",
  );
  assert.match(
    evidenceStep.run,
    /FAIL \(public edge\)/,
    "a public-edge FAIL record must be distinguished in the summary",
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
