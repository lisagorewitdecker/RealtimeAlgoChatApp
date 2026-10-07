import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

test("braces still expands patterns within the depth limit", () => {
  assert.deepEqual(braces.expand("a/{b,c}/d"), ["a/b/d", "a/c/d"]);
});
