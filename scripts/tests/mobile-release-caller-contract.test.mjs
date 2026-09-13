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