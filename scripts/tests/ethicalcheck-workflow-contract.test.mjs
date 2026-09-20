import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(workspaceRoot, ".github/workflows/ethicalcheck.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowText, { uniqueKeys: true });
const job = workflow.jobs?.Trigger_EthicalCheck;
const step = job?.steps?.[0];

function runEthicalCheckStep(env) {
  assert.ok(job, "expected the EthicalCheck workflow to define Trigger_EthicalCheck");
  assert.equal(typeof step?.run, "string", "expected Trigger_EthicalCheck to run inline bash");

  return spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("EthicalCheck workflow runs the scan inline instead of depending on a missing third-party action", () => {
  assert.ok(job, "expected the EthicalCheck workflow to define Trigger_EthicalCheck");
  assert.ok(step, "expected Trigger_EthicalCheck to define a first step");
  assert.equal(typeof step.run, "string", "expected Trigger_EthicalCheck to run inline bash");
  assert.equal(step.uses, undefined);
  assert.match(step.run, /\bcurl\b/);
  assert.match(step.run, /\bhttps:\/\/pentest\.apisec\.ai\/api\/v1\/pentest\b/);
  assert.match(step.run, /\bETHICALCHECK_OAS_URL\b/);
  assert.match(step.run, /\bETHICALCHECK_REPORT_EMAIL\b/);
  assert.equal(job.permissions?.contents, "read");
  assert.equal(job.permissions?.["security-events"], undefined);
  assert.doesNotMatch(workflowText, /apisec-inc\/ethicalcheck-action/);
  assert.doesNotMatch(workflowText, /upload-sarif/i);
});

test("EthicalCheck workflow skips cleanly when scan configuration is absent", () => {
  const result = runEthicalCheckStep({
    ETHICALCHECK_OAS_URL: "",
    ETHICALCHECK_REPORT_EMAIL: "",
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(
    result.stdout,
    /Skipping EthicalCheck scan because ETHICALCHECK_OAS_URL variable or ETHICALCHECK_REPORT_EMAIL secret is not configured\./,
  );
});

test("EthicalCheck workflow posts the expected request payload when configuration is present", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ethicalcheck-workflow-"));
  const fakeCurlPath = path.join(tempRoot, "curl");
  const argsPath = path.join(tempRoot, "curl-args.txt");
  const bodyPath = path.join(tempRoot, "curl-body.json");

  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${argsPath}"
while (($#)); do
  if [[ "$1" == "--data-raw" ]]; then
    printf '%s' "$2" > "${bodyPath}"
    exit 0
  fi
  shift
done
`,
    { mode: 0o755 },
  );

  try {
    const result = runEthicalCheckStep({
      PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
      ETHICALCHECK_OAS_URL: "https://example.test/openapi.json",
      ETHICALCHECK_REPORT_EMAIL: "security@example.test",
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const args = readFileSync(argsPath, "utf8");
    const payload = JSON.parse(readFileSync(bodyPath, "utf8"));

    assert.match(args, /--request\nPOST\n/);
    assert.match(args, /https:\/\/pentest\.apisec\.ai\/api\/v1\/pentest/);
    assert.deepEqual(payload, {
      openAPISpec: "https://example.test/openapi.json",
      email: "security@example.test",
      source: "Github-Action",
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
