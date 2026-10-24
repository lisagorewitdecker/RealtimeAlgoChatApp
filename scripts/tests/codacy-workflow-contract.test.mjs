import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowText = readFileSync(
  path.join(workspaceRoot, ".github/workflows/codacy.yml"),
  "utf8",
);

test("Codacy scan uses the updated analysis CLI action", () => {
  const scanAction = workflowText.match(
    /- name: Run Codacy Analysis CLI\n\s+uses: ([^\n]+)/,
  );

  assert.equal(
    scanAction?.[1],
    "codacy/codacy-analysis-cli-action@6f415a0d3790c227a9cff580098545188e0f4e5a",
  );
  assert.doesNotMatch(
    workflowText,
    /codacy\/codacy-analysis-cli-action@d840f886c4bd4edc059706d09c6a1586111c540b/,
  );
});
