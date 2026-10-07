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
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pnpmStore = join(repoRoot, "node_modules/.pnpm");
const packageDirectory = readdirSync(pnpmStore)
  .filter((name) => name.startsWith("braces@3.0.3"))
  .map((name) => join(pnpmStore, name, "node_modules/braces"))
  .find((path) => {
    try {
      createRequire(import.meta.url).resolve(join(path, "index.js"));
      return true;
    } catch {
      return false;
    }
  });

assert.ok(packageDirectory, "patched braces@3.0.3 must be installed");
const braces = createRequire(import.meta.url)(join(packageDirectory, "index.js"));

test("braces rejects over-nested brace and parenthesis patterns", () => {
  const patterns = [
    `${"{".repeat(101)}a,b${"}".repeat(101)}`,
    `${"(".repeat(101)}${")".repeat(101)}`,
  ];

  for (const pattern of patterns) {
    assert.throws(() => braces(pattern), /Input depth .* exceeds max depth \(100\)/);
  }
});

test("braces bounds recursive operations on deeply nested ASTs", () => {
  let node = { type: "text", value: "value" };
  for (let depth = 0; depth < 101; depth++) {
    const parent = { type: "brace", nodes: [node] };
    node.parent = parent;
    node = parent;
  }
  const ast = { type: "root", nodes: [node] };
  node.parent = ast;

  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(ast), /exceeds max depth \(100\)/);
  }
});

test("braces expand applies the global depth limit to invalid AST subtrees", () => {
  let node = { type: "text", value: "value" };
  for (let depth = 0; depth < 2; depth++) {
    const parent = { type: "brace", nodes: [node] };
    node.parent = parent;
    node = parent;
  }

  node = { type: "brace", invalid: true, nodes: [node] };
  node.nodes[0].parent = node;

  for (let depth = 0; depth < 99; depth++) {
    const parent = { type: "brace", nodes: [node] };
    node.parent = parent;
    node = parent;
  }

  const ast = { type: "root", nodes: [node] };
  node.parent = ast;

  assert.throws(() => braces.expand(ast), /AST depth .* exceeds max depth \(1\)/);
});

test("braces still expands patterns within the depth limit", () => {
  assert.deepEqual(braces.expand("a/{b,c}/d"), ["a/b/d", "a/c/d"]);
});
