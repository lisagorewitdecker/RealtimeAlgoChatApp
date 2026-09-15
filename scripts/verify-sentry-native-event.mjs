import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("expected paired --option value arguments");
    }
    options.set(key.slice(2), value);
  }
  return options;
}

function duplicateJsonFields(raw) {
  let index = 0;
  const duplicates = [];

  function skipWhitespace() {
    while (/\s/.test(raw[index] ?? "")) index += 1;
  }

  function readString() {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
      } else if (raw[index] === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error("unterminated JSON string");
  }

  function scanValue() {
    skipWhitespace();
    if (raw[index] === "{") {
      scanObject();
    } else if (raw[index] === "[") {
      scanArray();
    } else if (raw[index] === '"') {
      readString();
    } else {
      while (index < raw.length && !/[,\]}]/.test(raw[index])) index += 1;
    }
  }

  function scanObject() {
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (raw[index] === "}") {
      index += 1;
      return;
    }
    while (index < raw.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) duplicates.push(key);
      keys.add(key);
      skipWhitespace();
      index += 1;
      scanValue();
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      index += 1;
    }
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (raw[index] === "]") {
      index += 1;
      return;
    }
    while (index < raw.length) {
      scanValue();
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      index += 1;
    }
  }

  scanValue();
  return [...new Set(duplicates)];
}

function parseTrigger(triggerPath) {
  return Object.fromEntries(
    readFileSync(triggerPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

const cliOptions = parseArgs(process.argv.slice(2));
const evidencePath = cliOptions.get("evidence-path") ?? process.env.SENTRY_EVIDENCE_PATH;
const expectedPlatform = cliOptions.get("platform") ?? process.env.SENTRY_EXPECTED_PLATFORM;
const expectedBuildId = cliOptions.get("candidate-build-id") ?? process.env.SENTRY_EXPECTED_BUILD_ID;
const expectedProbeMarker = cliOptions.get("expected-probe-marker") ?? process.env.SENTRY_PROBE_MARKER ?? "";
const expectedRelease = cliOptions.get("expected-release") ?? process.env.SENTRY_EXPECTED_RELEASE ?? "";
const expectedDist = cliOptions.get("expected-dist") ?? process.env.SENTRY_EXPECTED_DIST ?? "";
const triggerPath =
  cliOptions.get("trigger-path") ??
  process.env.SENTRY_TRIGGER_PATH ??
  (evidencePath ? join(dirname(evidencePath), "sentry-trigger.txt") : undefined);

if (!evidencePath || !triggerPath || !expectedPlatform || !expectedBuildId) {
  throw new Error("missing evidence verification inputs");
}

const rawEvidence = readFileSync(evidencePath, "utf8");
if (/(?:auth(?:orization)?[_-]?token|sentry_auth_token|bearer\s+[A-Za-z0-9._-]+)/i.test(rawEvidence)) {
  throw new Error("evidence contains credential-like content");
}

let evidence;
try {
  evidence = JSON.parse(rawEvidence);
} catch {
  throw new Error("evidence is not valid JSON");
}

if (duplicateJsonFields(rawEvidence).length > 0) {
  throw new Error("duplicate JSON field(s)");
}

const trigger = parseTrigger(triggerPath);
for (const key of ["eventId", "marker", "release", "dist"]) {
  if (typeof evidence[key] !== "string" || evidence[key].trim() === "") {
    throw new Error(`${key} is missing`);
  }
}

if (evidence.status !== "PASS") throw new Error("status is not PASS");
if (evidence.platform !== expectedPlatform) throw new Error("platform does not match");
if (evidence.candidateBuildId !== expectedBuildId) throw new Error("candidate build ID does not match");
if (trigger.platform !== expectedPlatform) throw new Error("trigger platform does not match");
if (trigger.candidate_build_id !== expectedBuildId) throw new Error("trigger candidate build ID does not match");
if (trigger.marker !== evidence.marker) throw new Error("trigger marker does not match");
if (expectedProbeMarker && evidence.marker !== expectedProbeMarker) throw new Error("probe marker does not match");
if (expectedRelease && evidence.release !== expectedRelease) throw new Error("release does not match");
if (expectedDist && evidence.dist !== expectedDist) throw new Error("dist does not match");

const frame = evidence.readableFrame;
if (
  !frame ||
  typeof frame.filename !== "string" ||
  !/\.[cm]?[jt]sx?$/i.test(frame.filename) ||
  typeof frame.function !== "string" ||
  !frame.function.includes("createNativeSourceMapProbeError") ||
  !Number.isInteger(frame.line) ||
  !Number.isInteger(frame.column)
) {
  throw new Error("readable source-mapped frame is missing");
}
