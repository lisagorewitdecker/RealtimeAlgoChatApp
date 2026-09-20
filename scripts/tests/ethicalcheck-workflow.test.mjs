import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  workspaceRoot,
  ".github/workflows/ethicalcheck.yml",
);
const workflowText = readFileSync(workflowPath, "utf8");

test("EthicalCheck workflow pins the live action repository and preserves guarded SARIF upload", () => {
  assert.match(workflowText, /^permissions:\n  contents: read$/m);
  const jobBlockMatch = workflowText.match(
    /^\s+if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.fork == false$\n\s+permissions:\n(?<permissions>(?:\s{6}[^\n]+\n){3})\s+runs-on: ubuntu-latest$/m,
  );
  assert.ok(jobBlockMatch, "expected guarded job permissions before runs-on");
  assert.match(
    workflowText,
    /^\s+if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.fork == false$/m,
  );
  const { permissions: jobPermissions } = jobBlockMatch.groups;
  assert.match(jobPermissions, /^\s{6}contents: read\b/m);
  assert.match(jobPermissions, /^\s{6}security-events: write\b/m);
  assert.match(jobPermissions, /^\s{6}actions: read\b/m);
  assert.match(workflowText, /runs-on: ubuntu-latest/);
  assert.match(
    workflowText,
    /uses: Octota-GitHub\/ethicalcheck-action@3ec5e93b42e591349e46635da9f909bac66c23a9/,
  );
  assert.match(workflowText, /sarif-result-file: ethicalcheck-results\.sarif/);
  assert.match(
    workflowText,
    /uses: github\/codeql-action\/upload-sarif@6f5948dfacef28e207b48d0905cf90c03365536d/,
  );
  assert.match(workflowText, /sarif_file: \.\/ethicalcheck-results\.sarif/);
  assert.doesNotMatch(workflowText, /apisec-inc\/ethicalcheck-action/);
});
