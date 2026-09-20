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
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/ethicalcheck.yml",
);
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowText, { uniqueKeys: true });

test("EthicalCheck workflow inlines the scan trigger instead of referencing the missing third-party action", () => {
  assert.equal(workflow.name, "EthicalCheck-Workflow");
  assert.deepEqual(Object.keys(workflow.on), [
    "push",
    "pull_request",
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const triggerJob = workflow.jobs?.Trigger_EthicalCheck;
  assert.ok(triggerJob, "Trigger_EthicalCheck job must exist");
  assert.equal(
    triggerJob.if,
    "github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork == false",
  );
  assert.deepEqual(triggerJob.permissions, { contents: "read" });
  assert.equal(triggerJob["runs-on"], "ubuntu-latest");
  assert.equal(triggerJob.steps.length, 1);

  const [scanStep] = triggerJob.steps;
  assert.equal(
    scanStep.name,
    "EthicalCheck  Free & Automated API Security Testing Service",
  );
  assert.equal(scanStep.uses, undefined);
  assert.deepEqual(scanStep.env, {
    ETHICALCHECK_OAS_URL: "${{ vars.ETHICALCHECK_OAS_URL }}",
    ETHICALCHECK_REPORT_EMAIL: "${{ secrets.ETHICALCHECK_REPORT_EMAIL }}",
  });
  assert.match(
    scanStep.run,
    /Skipping EthicalCheck scan because ETHICALCHECK_OAS_URL variable or ETHICALCHECK_REPORT_EMAIL secret is not configured\./,
  );
  assert.match(
    scanStep.run,
    /::add-mask::\$\{ETHICALCHECK_REPORT_EMAIL\}/,
  );
  assert.match(scanStep.run, /payload="\$\(python3 - <<'PY'/);
  assert.match(scanStep.run, /import json/);
  assert.match(scanStep.run, /os\.environ\["ETHICALCHECK_OAS_URL"\]/);
  assert.match(scanStep.run, /os\.environ\["ETHICALCHECK_REPORT_EMAIL"\]/);
  assert.match(scanStep.run, /response_path="\$\(mktemp\)"/);
  assert.match(scanStep.run, /trap 'rm -f "\$response_path"' EXIT/);
  assert.match(scanStep.run, /--write-out '%\{http_code\}'/);
  assert.match(scanStep.run, /HTTP status \$\{http_status\}/);
  assert.match(scanStep.run, /\^2\[0-9\]\[0-9\]\$/);
  assert.match(scanStep.run, /response\.get\("code"\)/);
  assert.match(scanStep.run, /isinstance\(code, int\) and 200 <= code < 300/);
  assert.match(scanStep.run, /isinstance\(status, int\) and 200 <= status < 300/);
  assert.match(scanStep.run, /success\(\?:ful\(\?:ly\)\?\)\?\)/);
  assert.match(scanStep.run, /negative_pattern = re\.compile/);
  assert.match(scanStep.run, /and not negative_pattern\.search\(value\)/);
  assert.match(scanStep.run, /response did not confirm scan acceptance via success, code, message, or status fields/);
  assert.match(scanStep.run, /'https:\/\/pentest\.apisec\.ai\/api\/v1\/pentest'/);
  assert.doesNotMatch(workflowText, /apisec-inc\/ethicalcheck-action/);
  assert.doesNotMatch(workflowText, /upload-sarif/);
});
