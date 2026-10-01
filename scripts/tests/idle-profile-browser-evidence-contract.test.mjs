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
const playwrightConfig = readFileSync(
  path.join(workspaceRoot, "artifacts/api-server/e2e/playwright.config.ts"),
  "utf8",
);
const idleProfileSpec = readFileSync(
  path.join(
    workspaceRoot,
    "artifacts/api-server/e2e/idle-profile-registration.spec.ts",
  ),
  "utf8",
);
const e2eReadme = readFileSync(
  path.join(workspaceRoot, "artifacts/api-server/e2e/README.md"),
  "utf8",
);

const uploadArtifactAction =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const downloadArtifactAction =
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const evidencePath = "artifacts/api-server/test-results/**";
const contractArtifactName =
  "idle-profile-registration-browser-evidence-contract";

test("the idle-profile evidence contract runs without production secrets", () => {
  const job = workflow.jobs?.["idle-profile-browser-evidence-contract"];
  assert.ok(
    job,
    "mobile release must define the browser evidence contract job",
  );
  assert.equal(
    job.if,
    undefined,
    "the browser evidence contract must run for pull requests without release inputs",
  );
  assert.deepEqual(job.permissions, {
    actions: "write",
    contents: "read",
  });
  assert.doesNotMatch(
    JSON.stringify(job),
    /secrets\.|CLERK_|DATABASE_URL|E2E_(?:API|CHAT)_URL/,
    "the browser evidence contract must not depend on Clerk, database, or hosted target secrets",
  );

  const controlledRun = job.steps?.find(
    (step) => step.name === "Run controlled idle-profile browser failure",
  );
  assert.ok(
    controlledRun,
    "the contract job must run the controlled browser failure",
  );
  assert.equal(
    controlledRun["continue-on-error"],
    true,
    "the expected controlled browser failure must allow evidence upload to run",
  );
  assert.equal(controlledRun.env?.IDLE_PROFILE_EVIDENCE_CONTRACT, "1");
  assert.equal(
    controlledRun.env?.E2E_RECOVERY_DIAGNOSTIC_CONTRACT,
    "1",
    "the controlled run must skip the Clerk setup project",
  );
  assert.match(
    controlledRun.run,
    /playwright test[\s\\\n]+e2e\/idle-profile-registration\.spec\.ts[\s\\\n]+--config e2e\/playwright\.config\.ts/,
    "the contract must use the production idle-profile spec and Playwright config",
  );
  assert.match(
    controlledRun.run,
    /--grep ["']controlled browser failure["']/,
    "the contract must run only the controlled failure",
  );

  const upload = job.steps?.find(
    (step) => step.name === "Upload controlled idle-profile browser evidence",
  );
  assert.ok(upload, "the contract job must upload the controlled evidence");
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.uses, uploadArtifactAction);
  assert.equal(upload.with?.name, contractArtifactName);
  assert.equal(upload.with?.path, evidencePath);
  assert.equal(upload.with?.["if-no-files-found"], "error");

  const download = job.steps?.find(
    (step) => step.name === "Download controlled idle-profile browser evidence",
  );
  assert.ok(download, "the contract job must download the uploaded evidence");
  assert.equal(download.if, "${{ always() }}");
  assert.equal(download.uses, downloadArtifactAction);
  assert.equal(download.with?.name, contractArtifactName);

  const verify = job.steps?.find(
    (step) => step.name === "Verify controlled idle-profile browser evidence",
  );
  assert.ok(verify, "the contract job must verify the downloaded archive");
  assert.equal(verify.if, "${{ always() }}");
  assert.match(
    verify.run,
    /scripts\/check-idle-profile-browser-evidence\.sh/,
    "the contract job must use the shared exact-member validator",
  );
  assert.match(
    verify.run,
    /CONTROLLED_CHECK_RESULT.*failure/,
    "the contract must reject a controlled test that does not fail",
  );
  assert.match(
    verify.run,
    /DOWNLOAD_RESULT.*success/,
    "the contract must reject an unavailable uploaded artifact",
  );
});

test("the production idle-profile check keeps its browser evidence settings", () => {
  const job = workflow.jobs?.["idle-profile-registration"];
  assert.ok(job, "mobile release must define the idle-profile job");
  const run = job.steps?.find(
    (step) => step.name === "Run idle-profile registration release check",
  );
  const upload = job.steps?.find(
    (step) => step.name === "Upload idle-profile browser failure evidence",
  );
  assert.ok(run, "the release job must run the idle-profile check");
  assert.ok(upload, "the release job must upload idle-profile evidence");
  assert.ok(
    job.steps.indexOf(upload) > job.steps.indexOf(run),
    "the release evidence upload must follow the browser check",
  );
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.uses, uploadArtifactAction);
  assert.equal(upload.with?.name, "idle-profile-registration-browser-evidence");
  assert.equal(upload.with?.path, evidencePath);
  assert.match(
    playwrightConfig,
    /outputDir:\s*["']\.\.\/test-results["']/,
    "Playwright must write idle-profile evidence to the uploaded directory",
  );
  assert.match(
    playwrightConfig,
    /screenshot:\s*["']only-on-failure["']/,
    "Playwright must keep a screenshot when the release check fails",
  );
  assert.match(
    playwrightConfig,
    /trace:\s*["']retain-on-failure["']/,
    "Playwright must keep a trace when the release check fails",
  );
});

test("the controlled failure is opt-in and has no Clerk or database dependency", () => {
  const controlledTestMatch = /test\(\s*["']controlled browser failure/.exec(
    idleProfileSpec,
  );
  assert.ok(
    controlledTestMatch,
    "the controlled failure test must keep its expected source shape",
  );
  const controlledTestStart = controlledTestMatch.index;
  assert.match(
    idleProfileSpec,
    /IDLE_PROFILE_EVIDENCE_CONTRACT.*=== ["']1["']/,
    "the controlled failure must be explicitly opt-in",
  );
  assert.match(
    idleProfileSpec,
    /controlled browser failure produces the idle-profile evidence contract/,
    "the controlled failure test title must stay discoverable by the CI job",
  );
  assert.match(
    idleProfileSpec,
    /page\.setContent/,
    "the controlled failure must use local browser content",
  );
  assert.doesNotMatch(
    idleProfileSpec.slice(controlledTestStart),
    /createClerkClient|DATABASE_URL|E2E_(?:API|CHAT)_URL/,
    "the controlled failure body must not add a production service dependency",
  );
});

test("reviewers have downloadable idle-profile evidence instructions", () => {
  assert.match(
    e2eReadme,
    /idle-profile-registration-browser-evidence/,
    "the e2e README must name the release evidence artifact",
  );
  assert.match(
    e2eReadme,
    /test-failed-1\.png/,
    "the e2e README must identify the screenshot member",
  );
  assert.match(
    e2eReadme,
    /trace\.zip/,
    "the e2e README must identify the trace member",
  );
  assert.match(
    e2eReadme,
    /error-context\.md/,
    "the e2e README must identify the Playwright error-context member",
  );
  assert.match(
    e2eReadme,
    /show-trace/,
    "the e2e README must explain how to open the trace",
  );
});
