import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeZodIndex } from "./postprocess-generated.mjs";

const zodIndexPath = new URL(
  "../../../lib/api-zod/src/index.ts",
  import.meta.url,
);

test("removes Orval's generated wildcard export", () => {
  const index = [
    'export { HealthCheckResponse } from "./generated/api";',
    "export * from './generated/types';",
    "export * from './generated/api';",
    "export * from './generated/api';",
    "",
  ].join("\n");

  const normalized = normalizeZodIndex(index);

  assert.equal(
    normalized,
    'export { HealthCheckResponse } from "./generated/api";\n' +
      "export * from './generated/types';\n",
  );
  assert.equal(normalizeZodIndex(normalized), normalized);
});

test("Zod index normalization is idempotent", async () => {
  const index = await readFile(zodIndexPath, "utf8");
  const normalized = normalizeZodIndex(index);

  assert.equal(
    normalized,
    index,
    "generated API wildcard exports must be removed before codegen completes",
  );
  assert.equal(normalizeZodIndex(normalized), normalized);
  assert.match(normalized, /} from "\.\/generated\/api";/);
  assert.doesNotMatch(normalized, /export \* from ["']\.\/generated\/api["'];/);
});