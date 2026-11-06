/* jshint esversion: 11, node: true */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parse } from "yaml";

const appRequire = createRequire(
  new URL("../../artifacts/chat-app/package.json", import.meta.url),
);
const expoPackageRequire = createRequire(
  appRequire.resolve("expo/package.json"),
);
const expoRequire = createRequire(
  expoPackageRequire.resolve("@expo/config/package.json"),
);
const jestPackageRequire = createRequire(
  appRequire.resolve("jest/package.json"),
);
const jestCoreRequire = createRequire(
  jestPackageRequire.resolve("@jest/core/package.json"),
);
const jestRequire = createRequire(
  jestCoreRequire.resolve("jest-config/package.json"),
);
const deepmergeRequire = createRequire(expoRequire.resolve("deepmerge"));

test("every locked deepmerge consumer uses the committed security patch", () => {
  const lockfile = parse(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const patch = lockfile.patchedDependencies["deepmerge@4.3.1"];
  const hash = createHash("sha256")
    .update(readFileSync(new URL(`../../${patch.path}`, import.meta.url)))
    .digest("hex");
  assert.equal(patch.hash, hash);
  let consumers = 0;
  for (const snapshot of Object.values(lockfile.snapshots)) {
    const version = snapshot.dependencies?.deepmerge;
    if (version) {
      consumers += 1;
      assert.equal(version, `4.3.1(patch_hash=${hash})`);
    }
  }
  assert.ok(consumers > 0);
});

for (const [label, merge] of [
  ["Expo CommonJS", expoRequire("deepmerge")],
  ["Jest CommonJS", jestRequire("deepmerge")],
  ["UMD", deepmergeRequire("./umd.js")],
]) {
  test(`${label} prevents returned-object prototype poisoning for every target shape`, () => {
    const payload = JSON.parse('{"__proto__":{"isAdmin":true},"safe":"value"}');
    for (const target of [
      {},
      Object.create(null),
      null,
      undefined,
      0,
      "",
      JSON.parse('{"__proto__":{"isAdmin":true}}'),
    ]) {
      for (const result of [
        merge(target, payload),
        merge(payload, target || {}),
      ]) {
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(result.isAdmin, undefined);
        assert.equal(Object.hasOwn(result, "__proto__"), false);
        assert.equal(result.safe, "value");
      }
    }
    assert.equal({}.isAdmin, undefined);
  });

  test(`${label} filters dangerous keys before reading values or invoking custom merges`, () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const input = Object.defineProperty({}, key, {
        enumerable: true,
        get() {
          assert.fail(`must not read forbidden key ${key}`);
        },
      });
      assert.deepEqual(merge({}, input), {});
      assert.deepEqual(merge(input, {}), {});
      const payload = JSON.parse(`{"${key}":{"isAdmin":true}}`);
      assert.deepEqual(
        merge(payload, payload, {
          customMerge() {
            assert.fail("must not invoke customMerge for forbidden keys");
          },
        }),
        {},
      );
    }
  });

  test(`${label} protects nested objects, arrays, and merge.all`, () => {
    const payload = JSON.parse(
      '{"session":{"__proto__":{"isAdmin":true}},"items":[{"__proto__":{"isAdmin":true}}]}',
    );
    for (const result of [
      merge({ session: null }, payload),
      merge.all([{ session: null }, payload]),
    ]) {
      for (const object of [result.session, result.items[0]]) {
        assert.equal(Object.getPrototypeOf(object), Object.prototype);
        assert.equal(object.isAdmin, undefined);
        assert.equal(Object.hasOwn(object, "__proto__"), false);
      }
    }
  });

  test(`${label} preserves ordinary merge options, symbols, and property descriptors`, () => {
    const symbol = Symbol("configuration");
    const target = {
      nested: { first: true },
      array: [1],
      [symbol]: { first: true },
    };
    const source = {
      nested: { second: true },
      array: [2],
      [symbol]: { second: true },
    };
    const result = merge(target, source);
    assert.deepEqual(result, {
      nested: { first: true, second: true },
      array: [1, 2],
      [symbol]: { first: true, second: true },
    });
    assert.notEqual(result.nested, target.nested);
    assert.deepEqual(target.array, [1]);
    assert.deepEqual(source.array, [2]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(result, "nested"), {
      value: result.nested,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    assert.deepEqual(
      merge(target, source, { arrayMerge: (_, values) => values }).array,
      [2],
    );
    assert.deepEqual(merge({ name: "first" }, { name: "second" }), {
      name: "second",
    });
    assert.deepEqual(
      merge({ nested: { first: true } }, source, {
        customMerge: (key) =>
          key === "nested" ? () => ({ custom: true }) : undefined,
      }).nested,
      { custom: true },
    );
    assert.equal(
      merge({}, { nested: source.nested }, { clone: false }).nested,
      source.nested,
    );
    assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  });
}
