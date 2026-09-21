#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MERGE_MARKER_LINE_PATTERN =
  /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s|$)/gm;
const POSITION_PATTERN = /\bat position\s+(\d+)/;

function trackedPackageManifests() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--", "*package.json"],
      { encoding: "utf8" },
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown git error";
    throw new Error(`could not list tracked package manifests: ${detail}`);
  }
}

function lineAndColumn(source, position) {
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return { line, column };
}

function markerDiagnostic(source) {
  MERGE_MARKER_LINE_PATTERN.lastIndex = 0;
  const match = MERGE_MARKER_LINE_PATTERN.exec(source);
  if (!match) {
    return null;
  }

  const line = source.slice(0, match.index).split("\n").length;
  return `unresolved merge marker ${match[1]} on line ${line}`;
}

function parseDiagnostic(source) {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "JSON value must be an object";
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const positionMatch = message.match(POSITION_PATTERN);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    const location =
      position === null || !Number.isSafeInteger(position)
        ? ""
        : (() => {
            const { line, column } = lineAndColumn(source, position);
            return ` at line ${line} column ${column}`;
          })();

    const hasTrailingContent =
      message.includes("non-whitespace character after JSON") ||
      (position !== null &&
        Number.isSafeInteger(position) &&
        (() => {
          try {
            JSON.parse(source.slice(0, position));
            return true;
          } catch {
            return false;
          }
        })());

    if (hasTrailingContent) {
      return `JSON parse error${location}: trailing content after the first JSON value`;
    }

    const unexpectedToken = message.match(/Unexpected token ['"]([^'"]+)['"]/);
    const reason = message.includes("Unexpected end")
      ? "unexpected end of input"
      : unexpectedToken
        ? `unexpected token ${unexpectedToken[1]}`
        : "invalid JSON syntax";
    return `JSON parse error${location}: ${reason}`;
  }
}

function validateManifest(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "could not read file";
  }

  return markerDiagnostic(source) ?? parseDiagnostic(source);
}

function main() {
  const paths = process.argv.slice(2);
  const manifests = paths.length > 0 ? paths : trackedPackageManifests();

  if (manifests.length === 0) {
    console.error("Package manifest validation failed: no tracked package.json files found.");
    process.exitCode = 1;
    return;
  }

  const failures = [];
  for (const path of manifests) {
    const problem = validateManifest(path);
    if (problem) {
      failures.push({ path, problem });
    }
  }

  if (failures.length > 0) {
    console.error("Package manifest validation failed:");
    for (const { path, problem } of failures) {
      console.error(`- ${path}: ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${manifests.length} tracked package manifest(s).`);
}

try {
  main();
} catch (error) {
  console.error(
    `Package manifest validation failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  process.exitCode = 1;
}#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MERGE_MARKER_LINE_PATTERN =
  /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s|$)/gm;
const POSITION_PATTERN = /\bat position\s+(\d+)/;

function trackedPackageManifests() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--", "*package.json"],
      { encoding: "utf8" },
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown git error";
    throw new Error(`could not list tracked package manifests: ${detail}`);
  }
}

function lineAndColumn(source, position) {
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return { line, column };
}

function markerDiagnostic(source) {
  MERGE_MARKER_LINE_PATTERN.lastIndex = 0;
  const match = MERGE_MARKER_LINE_PATTERN.exec(source);
  if (!match) {
    return null;
  }

  const line = source.slice(0, match.index).split("\n").length;
  return `unresolved merge marker ${match[1]} on line ${line}`;
}

function parseDiagnostic(source) {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "JSON value must be an object";
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const positionMatch = message.match(POSITION_PATTERN);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    const location =
      position === null || !Number.isSafeInteger(position)
        ? ""
        : (() => {
            const { line, column } = lineAndColumn(source, position);
            return ` at line ${line} column ${column}`;
          })();

    const hasTrailingContent =
      message.includes("non-whitespace character after JSON") ||
      (position !== null &&
        Number.isSafeInteger(position) &&
        (() => {
          try {
            JSON.parse(source.slice(0, position));
            return true;
          } catch {
            return false;
          }
        })());

    if (hasTrailingContent) {
      return `JSON parse error${location}: trailing content after the first JSON value`;
    }

    const unexpectedToken = message.match(/Unexpected token ['"]([^'"]+)['"]/);
    const reason = message.includes("Unexpected end")
      ? "unexpected end of input"
      : unexpectedToken
        ? `unexpected token ${unexpectedToken[1]}`
        : "invalid JSON syntax";
    return `JSON parse error${location}: ${reason}`;
  }
}

function validateManifest(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "could not read file";
  }

  return markerDiagnostic(source) ?? parseDiagnostic(source);
}

function main() {
  const paths = process.argv.slice(2);
  const manifests = paths.length > 0 ? paths : trackedPackageManifests();

  if (manifests.length === 0) {
    console.error("Package manifest validation failed: no tracked package.json files found.");
    process.exitCode = 1;
    return;
  }

  const failures = [];
  for (const path of manifests) {
    const problem = validateManifest(path);
    if (problem) {
      failures.push({ path, problem });
    }
  }

  if (failures.length > 0) {
    console.error("Package manifest validation failed:");
    for (const { path, problem } of failures) {
      console.error(`- ${path}: ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${manifests.length} tracked package manifest(s).`);
}

try {
  main();
} catch (error) {
  console.error(
    `Package manifest validation failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  process.exitCode = 1;
}#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MERGE_MARKER_LINE_PATTERN =
  /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s|$)/gm;
const POSITION_PATTERN = /\bat position\s+(\d+)/;

function trackedPackageManifests() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--", "*package.json"],
      { encoding: "utf8" },
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown git error";
    throw new Error(`could not list tracked package manifests: ${detail}`);
  }
}

function lineAndColumn(source, position) {
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return { line, column };
}

function markerDiagnostic(source) {
  MERGE_MARKER_LINE_PATTERN.lastIndex = 0;
  const match = MERGE_MARKER_LINE_PATTERN.exec(source);
  if (!match) {
    return null;
  }

  const line = source.slice(0, match.index).split("\n").length;
  return `unresolved merge marker ${match[1]} on line ${line}`;
}

function parseDiagnostic(source) {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "JSON value must be an object";
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const positionMatch = message.match(POSITION_PATTERN);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    const location =
      position === null || !Number.isSafeInteger(position)
        ? ""
        : (() => {
            const { line, column } = lineAndColumn(source, position);
            return ` at line ${line} column ${column}`;
          })();

    const hasTrailingContent =
      message.includes("non-whitespace character after JSON") ||
      (position !== null &&
        Number.isSafeInteger(position) &&
        (() => {
          try {
            JSON.parse(source.slice(0, position));
            return true;
          } catch {
            return false;
          }
        })());

    if (hasTrailingContent) {
      return `JSON parse error${location}: trailing content after the first JSON value`;
    }

    const unexpectedToken = message.match(/Unexpected token ['"]([^'"]+)['"]/);
    const reason = message.includes("Unexpected end")
      ? "unexpected end of input"
      : unexpectedToken
        ? `unexpected token ${unexpectedToken[1]}`
        : "invalid JSON syntax";
    return `JSON parse error${location}: ${reason}`;
  }
}

function validateManifest(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "could not read file";
  }

  return markerDiagnostic(source) ?? parseDiagnostic(source);
}

function main() {
  const paths = process.argv.slice(2);
  const manifests = paths.length > 0 ? paths : trackedPackageManifests();

  if (manifests.length === 0) {
    console.error("Package manifest validation failed: no tracked package.json files found.");
    process.exitCode = 1;
    return;
  }

  const failures = [];
  for (const path of manifests) {
    const problem = validateManifest(path);
    if (problem) {
      failures.push({ path, problem });
    }
  }

  if (failures.length > 0) {
    console.error("Package manifest validation failed:");
    for (const { path, problem } of failures) {
      console.error(`- ${path}: ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${manifests.length} tracked package manifest(s).`);
}

try {
  main();
} catch (error) {
  console.error(
    `Package manifest validation failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  process.exitCode = 1;
}#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MERGE_MARKER_LINE_PATTERN =
  /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s|$)/gm;
const POSITION_PATTERN = /\bat position\s+(\d+)/;

function trackedPackageManifests() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--", "*package.json"],
      { encoding: "utf8" },
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown git error";
    throw new Error(`could not list tracked package manifests: ${detail}`);
  }
}

function lineAndColumn(source, position) {
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return { line, column };
}

function markerDiagnostic(source) {
  MERGE_MARKER_LINE_PATTERN.lastIndex = 0;
  const match = MERGE_MARKER_LINE_PATTERN.exec(source);
  if (!match) {
    return null;
  }

  const line = source.slice(0, match.index).split("\n").length;
  return `unresolved merge marker ${match[1]} on line ${line}`;
}

function parseDiagnostic(source) {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "JSON value must be an object";
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const positionMatch = message.match(POSITION_PATTERN);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    const location =
      position === null || !Number.isSafeInteger(position)
        ? ""
        : (() => {
            const { line, column } = lineAndColumn(source, position);
            return ` at line ${line} column ${column}`;
          })();

    const hasTrailingContent =
      message.includes("non-whitespace character after JSON") ||
      (position !== null &&
        Number.isSafeInteger(position) &&
        (() => {
          try {
            JSON.parse(source.slice(0, position));
            return true;
          } catch {
            return false;
          }
        })());

    if (hasTrailingContent) {
      return `JSON parse error${location}: trailing content after the first JSON value`;
    }

    const unexpectedToken = message.match(/Unexpected token ['"]([^'"]+)['"]/);
    const reason = message.includes("Unexpected end")
      ? "unexpected end of input"
      : unexpectedToken
        ? `unexpected token ${unexpectedToken[1]}`
        : "invalid JSON syntax";
    return `JSON parse error${location}: ${reason}`;
  }
}

function validateManifest(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "could not read file";
  }

  return markerDiagnostic(source) ?? parseDiagnostic(source);
}

function main() {
  const paths = process.argv.slice(2);
  const manifests = paths.length > 0 ? paths : trackedPackageManifests();

  if (manifests.length === 0) {
    console.error("Package manifest validation failed: no tracked package.json files found.");
    process.exitCode = 1;
    return;
  }

  const failures = [];
  for (const path of manifests) {
    const problem = validateManifest(path);
    if (problem) {
      failures.push({ path, problem });
    }
  }

  if (failures.length > 0) {
    console.error("Package manifest validation failed:");
    for (const { path, problem } of failures) {
      console.error(`- ${path}: ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${manifests.length} tracked package manifest(s).`);
}

try {
  main();
} catch (error) {
  console.error(
    `Package manifest validation failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  process.exitCode = 1;
}