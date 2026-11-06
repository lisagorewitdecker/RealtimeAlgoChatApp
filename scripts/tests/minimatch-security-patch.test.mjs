/* jshint esversion: 11, node: true */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { parse } from "yaml";

const appRequire = createRequire(
  new URL("../../artifacts/chat-app/package.json", import.meta.url),
);
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const cliRequire = createRequire(appRequire.resolve("@expo/cli/package.json"));
const fingerprintRequire = createRequire(
  expoRequire.resolve("@expo/fingerprint/package.json"),
);
const specRequire = createRequire(
  new URL("../../lib/api-spec/package.json", import.meta.url),
);
const orvalRequire = createRequire(specRequire.resolve("orval/package.json"));
const typedocRequire = createRequire(
  orvalRequire.resolve("typedoc/package.json"),
);
const globRequire = createRequire(cliRequire.resolve("glob/package.json"));

test("the lockfile excludes minimatch releases affected by GHSA-g3hv-75wg-m249", () => {
  const lockfile = parse(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const versions = Object.keys(lockfile.packages)
    .filter((name) => name.startsWith("minimatch@"))
    .map((name) => name.slice("minimatch@".length));
  assert.ok(versions.length > 0);
  for (const version of versions) {
    assert.equal(
      semver.satisfies(version, ">=7.0.0 <11.0.1"),
      false,
      `vulnerable minimatch ${version}`,
    );
  }
});

test("the lockfile registers the TypeDoc compatibility patch on every resolution", () => {
  const lockfile = parse(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const patch = lockfile.patchedDependencies["typedoc@0.28.19"];
  const hash = createHash("sha256")
    .update(readFileSync(new URL(`../../${patch.path}`, import.meta.url)))
    .digest("hex");
  assert.equal(patch.hash, hash);
  const resolutions = Object.keys(lockfile.snapshots).filter((key) =>
    key.startsWith("typedoc@"),
  );
  assert.ok(resolutions.length > 0);
  for (const resolution of resolutions) {
    assert.ok(resolution.includes(`(patch_hash=${hash})`), resolution);
  }
});

for (const [label, require] of [
  ["Glob", globRequire],
  ["Expo fingerprint", fingerprintRequire],
  ["TypeDoc", typedocRequire],
]) {
  const packagePath = require.resolve("minimatch/package.json");
  const esmPath = join(dirname(packagePath), require(packagePath).module);

  test(`${label} bounds globparts amplification in CommonJS and ESM`, () => {
    // Isolate synchronous compilation so a regression cannot hang the test runner.
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { createRequire } from "node:module";
          const require = createRequire(${JSON.stringify(packagePath)});
          for (const { Minimatch } of [
            require("./dist/commonjs/index.js"),
            await import(${JSON.stringify(pathToFileURL(esmPath).href)}),
          ]) {
            const pattern = Array(30).fill("**/../a/b").join("/");
            for (const braceExpandMax of [8, 64]) {
              const mm = new Minimatch(pattern, {
                optimizationLevel: 2,
                braceExpandMax,
              });
              assert.equal(mm.set.length, braceExpandMax);
            }
            const bounded = new Minimatch(
              Array(18).fill("**/../a").join("/"),
              { optimizationLevel: 2 },
            );
            assert.equal(bounded.set.length, 100_000);
            const small = new Minimatch("{x,*}/{0..9}", { optimizationLevel: 2 });
            assert.equal(small.set.length, 10);
            const large = new Minimatch("{x,*}/{0..999}", { optimizationLevel: 2 });
            assert.equal(large.set.length, 2000);
            assert.equal(large.match("x/5"), true);
            assert.equal(large.match("y/999"), true);
            assert.equal(large.match(".y/5"), false);
          }
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${label} preserves ordinary pattern matching and small optimizations`, () => {
    const { Minimatch, minimatch } = require("minimatch");
    const mm = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
    assert.equal(mm.set.length, 4);
    assert.equal(mm.match("../a/b/../c/d"), true);
    assert.equal(mm.match("x/a/b/y/c/d"), true);
    assert.equal(minimatch("src/nested/file.ts", "src/**/*.{ts,tsx}"), true);
    assert.equal(minimatch("src/file.js", "src/**/*.{ts,tsx}"), false);
    assert.equal(minimatch("src/.hidden.ts", "src/**/*.ts"), false);
    assert.equal(
      minimatch("src/.hidden.ts", "src/**/*.ts", { dot: true }),
      true,
    );
    assert.equal(minimatch("src/file.test.ts", "!**/*.test.ts"), false);
  });
}

test("Expo fingerprint preserves ignore and negated ignore handling", () => {
  const { isIgnoredPath, buildPathMatchObjects, buildDirMatchObjects } =
    fingerprintRequire("./build/utils/Path.js");
  const patterns = ["**/generated/**", "!**/generated/keep.ts"];
  assert.equal(isIgnoredPath("src/generated/skip.ts", patterns), true);
  assert.equal(isIgnoredPath("src/generated/keep.ts", patterns), false);
  assert.equal(isIgnoredPath("src/index.ts", patterns), false);
  assert.equal(isIgnoredPath("src/.hidden/file.ts", ["**/.hidden/**"]), true);
  assert.deepEqual(buildDirMatchObjects(buildPathMatchObjects(patterns)), []);
});

test("TypeDoc retains nested glob discovery with minimatch 11", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "minimatch-typedoc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    "src/index.ts",
    "src/nested/component.tsx",
    "src/nested/skip.js",
    "src/.hidden/secret.ts",
    "src/node_modules/dependency/index.ts",
    "docs/example.ts",
  ]) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  const { glob } = await import(
    pathToFileURL(typedocRequire.resolve("./dist/lib/utils/fs.js")).href
  );
  assert.deepEqual(glob(`${root}/src/**/*.{ts,tsx}`, root).sort(), [
    join(root, "src/index.ts"),
    join(root, "src/nested/component.tsx"),
  ]);
  assert.deepEqual(glob(`${root}/src/node_modules/**/*.ts`, root), [
    join(root, "src/node_modules/dependency/index.ts"),
  ]);
  assert.deepEqual(glob(`!${root}/src/**/*.{ts,tsx}`, root), [
    join(root, "src/nested/skip.js"),
  ]);
  const { splitGlobToPathAndSpecial } = await import(
    pathToFileURL(typedocRequire.resolve("./dist/lib/utils/paths.js")).href
  );
  const split = splitGlobToPathAndSpecial(`${root}/src/**/*.{ts,tsx}`);
  assert.equal(split.modifiers, "");
  assert.equal(split.path, `${root}/src`);
  const { minimatch } = typedocRequire("minimatch");
  for (const path of ["index.ts", "nested/component.tsx", "nested/skip.js"]) {
    assert.equal(
      minimatch(path, split.glob),
      minimatch(path, "**/*.{ts,tsx}"),
      path,
    );
  }
});
