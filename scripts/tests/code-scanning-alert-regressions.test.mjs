import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readRepositoryFile(filePath) {
  return readFileSync(path.join(repositoryRoot, filePath), "utf8");
}

test("token generator declares its supported JSHint syntax version", () => {
  const source = readRepositoryFile(
    "artifacts/realtime-algo-chat-design-system/scripts/build-tokens.mjs",
  );

  assert.match(source, /^\/\* jshint esversion: 11, node: true \*\//);
});

test("flagged chat-app tests declare their supported JSHint syntax version", () => {
  for (const filePath of [
    "artifacts/chat-app/plugins/withSentryNativeUpload.test.mjs",
    "artifacts/chat-app/scripts/validate-branding.test.mjs",
  ]) {
    const source = readRepositoryFile(filePath);
    assert.match(source, /^\/\* jshint esversion: 11, node: true \*\//);
  }
});

function getFunctionBody(source, functionName) {
  const declaration = new RegExp(`function ${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = declaration.exec(source);
  assert.ok(match, `expected to find function ${functionName}`);

  const bodyStart = match.index + match[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }

  assert.fail(`expected function ${functionName} to have a closing brace`);
}

test("physical-device supplement uses unique section headings", () => {
  const markdown = readRepositoryFile(
    "test-results/native-large-text/physical-device-supplement.md",
  );
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map(
    (match) => match[1],
  );

  assert.equal(new Set(headings).size, headings.length);
});

test("theme fallback and relative-color declarations are unique per block", () => {
  const stylesheet = readRepositoryFile(
    "artifacts/realtime-algo-chat-design-system/scripts/theme-template.css",
  );
  const blocks = [
    ...stylesheet.matchAll(/(?:^|\n)\s*(:root|\.dark)\s*\{([^{}]*)\}/g),
  ].map((match) => ({ selector: match[1], content: match[2] }));
  const properties = [
    "--sidebar-primary-border",
    "--sidebar-accent-border",
    "--primary-border",
    "--secondary-border",
    "--muted-border",
    "--accent-border",
    "--destructive-border",
  ];

  assert.equal(blocks.length, 4);
  assert.match(stylesheet, /@supports \(color: hsl\(from red h s calc\(l \+ 1\)\)\)/);

  for (const { content } of blocks) {
    const declarations = [...content.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(
      (match) => match[1],
    );
    assert.equal(new Set(declarations).size, declarations.length);
  }

  for (const property of properties) {
    const declaration = new RegExp(`^\\s*${property}:\\s*([^;]+);`, "gm");
    const values = [...stylesheet.matchAll(declaration)].map(
      (match) => match[1],
    );
    assert.equal(values.length, 4, `${property} should have both modes and overrides`);
    assert.equal(values.filter((value) => value.startsWith("hsl(var(")).length, 2);
    assert.equal(values.filter((value) => value.startsWith("hsl(from ")).length, 2);
  }
});

test("flagged server and image parser functions use consistent return statements", () => {
  const server = readRepositoryFile("artifacts/chat-app/server/serve.js");
  const imageSize = readRepositoryFile("vendor/image-size-secure/index.js");
  const functions = [
    [server, "createStaticServer"],
    ...[
      "readPng",
      "readGif",
      "readBmp",
      "readJpeg",
      "readWebp",
      "readPsd",
      "readSvg",
      "readTiff",
      "readKtx",
      "imageSize",
    ].map((name) => [imageSize, name]),
  ];

  for (const [source, name] of functions) {
    assert.doesNotMatch(
      getFunctionBody(source, name),
      /\breturn\s*;/,
      `${name} should not mix value returns with bare returns`,
    );
  }
});
