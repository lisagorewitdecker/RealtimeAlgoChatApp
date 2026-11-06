/* jshint esversion: 11, node: true */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parse } from "yaml";
import semver from "semver";

const appRequire = createRequire(
  new URL("../../artifacts/chat-app/package.json", import.meta.url),
);
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const cliRequires = [appRequire, expoRequire].map((require) =>
  createRequire(require.resolve("@expo/cli/package.json")),
);

test("the lockfile contains no Zod release affected by GHSA-mrhx-c7xc-m3w5", () => {
  const lockfile = parse(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const versions = Object.keys(lockfile.packages)
    .filter((name) => name.startsWith("zod@"))
    .map((name) => name.slice("zod@".length));

  assert.ok(versions.length > 0);
  for (const version of versions) {
    assert.ok(semver.gte(version, "4.6.6"), `vulnerable Zod ${version}`);
  }
});

for (const [label, require] of [
  ["chat app", appRequire],
  ...cliRequires.map((require) => [
    `Expo CLI ${require("./package.json").version}`,
    require,
  ]),
]) {
  const { z } = require("zod");

  test(`${label} rejects oversized constrained collections before parsing elements`, async () => {
    let visited = 0;
    const element = z.preprocess((value) => {
      visited += 1;
      return value;
    }, z.string());
    const values = Array.from({ length: 10_000 }, (_, index) => index);
    const cases = [
      [z.array(element).max(2), values],
      [z.array(element).length(2), values],
      [z.set(element).max(2), new Set(values)],
      [z.set(element).size(2), new Set(values)],
      [z.map(element, element).max(2), new Map(values.map((n) => [n, n]))],
      [z.map(element, element).size(2), new Map(values.map((n) => [n, n]))],
    ];

    for (const [schema, input] of cases) {
      for (const result of [
        schema.safeParse(input),
        await schema.safeParseAsync(input),
      ]) {
        assert.equal(result.success, false);
        assert.equal(result.error.issues.length, 1);
        assert.equal(result.error.issues[0].code, "too_big");
      }
    }
    assert.equal(
      visited,
      0,
      "oversized inputs must not allocate per-element issues",
    );
  });

  test(`${label} preserves validation within collection limits`, () => {
    assert.deepEqual(z.array(z.string()).max(2).parse(["ok"]), ["ok"]);
    assert.deepEqual(z.array(z.string()).length(1).parse(["ok"]), ["ok"]);
    assert.deepEqual(
      z
        .set(z.string())
        .size(1)
        .parse(new Set(["ok"])),
      new Set(["ok"]),
    );
    const entries = new Map([["key", "value"]]);
    assert.deepEqual(
      z.map(z.string(), z.string()).size(1).parse(entries),
      entries,
    );
    const result = z.array(z.string()).max(2).safeParse([123]);
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].code, "invalid_type");
    assert.deepEqual(result.error.issues[0].path, [0]);
  });
}

for (const require of cliRequires) {
  const version = require("./package.json").version;
  const {
    PluginSchema,
    DevToolsPluginOutputSchema,
  } = require("./build/src/start/server/DevToolsPlugin.schema.js");
  const {
    createMCPDevToolsExtensionSchema,
  } = require("./build/src/start/server/createMCPDevToolsExtensionSchema.js");

  test(`Expo CLI ${version} plugin and MCP schemas remain compatible with Zod 4`, () => {
    const plugin = PluginSchema.parse({
      packageName: "test-plugin",
      packageRoot: "/test-plugin",
      cliExtensions: {
        description: "Test commands",
        entryPoint: "index.js",
        commands: [
          {
            name: "run",
            title: "Run",
            environments: ["cli", "mcp"],
            parameters: [
              { name: "message", type: "text" },
              { name: "count", type: "number" },
              { name: "confirm", type: "confirm" },
            ],
          },
        ],
      },
    });
    const schema = createMCPDevToolsExtensionSchema(plugin);
    const command = { command: "run", message: "ok", count: 1, confirm: true };
    assert.deepEqual(schema.parse(command), command);
    assert.equal(schema.safeParse({ ...command, count: "1" }).success, false);
    assert.equal(
      schema.safeParse({ ...command, command: "unknown" }).success,
      false,
    );
    assert.equal(schema.safeParse({ ...command, extra: true }).success, false);
    assert.equal(PluginSchema.safeParse({ packageName: "" }).success, false);

    const output = [
      { type: "text", text: "ok", level: "info" },
      { type: "audio", url: "https://example.com/audio" },
      { type: "image", url: "https://example.com/image" },
    ];
    assert.deepEqual(DevToolsPluginOutputSchema.parse(output), output);
    assert.equal(
      DevToolsPluginOutputSchema.safeParse([{ type: "audio", url: "invalid" }])
        .success,
      false,
    );
  });
}
