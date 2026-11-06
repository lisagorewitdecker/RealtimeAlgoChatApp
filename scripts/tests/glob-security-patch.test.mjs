/* jshint esversion: 11, node: true */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import semver from "semver";

const appRequire = createRequire(
  new URL("../../artifacts/chat-app/package.json", import.meta.url),
);
const cliRequire = createRequire(appRequire.resolve("@expo/cli/package.json"));
const { glob, globSync, globStream, globStreamSync } = cliRequire("glob");

test("the lockfile excludes Glob releases affected by GHSA-3g3m-2fjr-6pw4", () => {
  const lockfile = parse(
    fs.readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const versions = Object.keys(lockfile.packages)
    .filter((name) => name.startsWith("glob@"))
    .map((name) => name.slice("glob@".length));
  assert.ok(versions.length > 0);
  for (const version of versions) {
    assert.equal(
      semver.satisfies(version, ">=9.0.0 <14.0.2"),
      false,
      `vulnerable Glob ${version}`,
    );
  }
});

function fixture(t) {
  const cwd = fs.mkdtempSync(join(tmpdir(), "glob-cancellation-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (let parent = 0; parent < 4; parent += 1) {
    for (let child = 0; child < 4; child += 1) {
      const directory = join(cwd, `parent-${parent}`, `child-${child}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(join(directory, "fixture.txt"), "fixture");
    }
  }
  return cwd;
}

for (const [mode, cancellation] of [
  ["promise", "abort"],
  ["stream", "abort"],
  ["promise", "timeout"],
  ["stream", "timeout"],
]) {
  test(`Glob ${mode} stops directory reads after ${cancellation}`, async (t) => {
    const cwd = fixture(t);
    const controller = new AbortController();
    const reason = new Error("cancel traversal");
    const signal =
      cancellation === "timeout" ? AbortSignal.timeout(10) : controller.signal;
    let reads = 0;
    const pending = new Set();
    const countedFs = {
      ...fs,
      readdir(path, options, callback) {
        reads += 1;
        if (reads === 1 && cancellation === "abort") controller.abort(reason);
        const completion = new Promise((resolve) => {
          fs.readdir(path, options, (...args) => {
            const finish = () => {
              try {
                callback(...args);
              } finally {
                resolve();
              }
            };
            if (cancellation === "timeout") setTimeout(finish, 30);
            else finish();
          });
        });
        pending.add(completion);
        completion.then(() => pending.delete(completion));
      },
    };
    const options = { cwd, signal, fs: countedFs };
    await assert.rejects(
      async () => {
        if (mode === "promise") {
          await glob("**", options);
        } else {
          for await (const entry of globStream("**", options)) {
            assert.ok(entry);
          }
        }
      },
      (error) =>
        cancellation === "timeout"
          ? error.name === "TimeoutError"
          : error === reason,
    );
    const readsAtRejection = reads;
    while (pending.size > 0) await Promise.all([...pending]);
    if (cancellation === "abort") assert.equal(readsAtRejection, 1);
    else assert.ok(readsAtRejection <= 1);
    assert.equal(reads, readsAtRejection, "no directory reads after rejection");
  });
}

test("Glob synchronous streams stop directory reads after cancellation", async (t) => {
  const cwd = fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel synchronous traversal");
  let reads = 0;
  const countedFs = {
    ...fs,
    readdirSync(...args) {
      reads += 1;
      if (reads === 1) controller.abort(reason);
      return fs.readdirSync(...args);
    },
  };
  const error = await new Promise((resolve) => {
    const stream = globStreamSync("**", {
      cwd,
      signal: controller.signal,
      fs: countedFs,
    });
    stream.on("error", resolve);
    stream.resume();
  });
  assert.equal(error, reason);
  assert.equal(reads, 1);
});

test("Glob retains ordinary promise, sync, and streaming traversal", async (t) => {
  const cwd = fixture(t);
  const options = { cwd, nodir: true };
  const expected = globSync("**/*.txt", options).sort();
  assert.equal(expected.length, 16);
  assert.deepEqual((await glob("**/*.txt", options)).sort(), expected);
  for (const stream of [
    globStream("**/*.txt", options),
    globStreamSync("**/*.txt", options),
  ]) {
    const entries = [];
    for await (const entry of stream) entries.push(entry);
    assert.deepEqual(entries.sort(), expected);
  }
});
