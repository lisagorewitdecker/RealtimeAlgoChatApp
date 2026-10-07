import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const chatAppRequire = createRequire(resolve(repoRoot, "artifacts/chat-app/package.json"));
const cliRequire = createRequire(chatAppRequire.resolve("@expo/cli"));
const metroFileMapRequire = createRequire(cliRequire.resolve("@expo/metro-file-map"));
const micromatchRequire = createRequire(metroFileMapRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");

test("braces continues to compile and expand ordinary patterns", () => {
  assert.deepEqual(braces("{a,b}"), ["(a|b)"]);
  assert.deepEqual(braces("{a,b}", { expand: true }), ["a", "b"]);
});

test("braces rejects deeply nested patterns before recursive processing", () => {
  const depth = 1_000;

  for (const [open, close] of [
    ["{", "}"],
    ["(", ")"],
  ]) {
    const pattern = `${open.repeat(depth)}x${close.repeat(depth)}`;

    assert.throws(
      () => braces(pattern),
      {
        name: "SyntaxError",
        message: "Input nesting exceeds maximum depth (100)",
      },
    );
  }
});
