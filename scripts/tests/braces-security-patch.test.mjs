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
        message: "Input depth (101), exceeds max depth (100)",
      },
    );
  }
});

test("braces bounds recursive processing of externally supplied ASTs", () => {
  let ast = { type: "text", value: "x" };
  for (let index = 0; index < 101; index += 1) {
    ast = { type: "brace", nodes: [ast] };
  }
  ast = { type: "root", nodes: [ast] };

  for (const process of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => process(ast), {
      name: "RangeError",
    });
  }
});

test("braces rejects cyclic AST parent chains during expansion", () => {
  const ast = { type: "paren", nodes: [{ type: "text", value: "x" }] };
  ast.parent = ast;

  assert.throws(() => braces.expand(ast), {
    name: "RangeError",
    message: "AST parent chain contains a cycle",
  });
});
