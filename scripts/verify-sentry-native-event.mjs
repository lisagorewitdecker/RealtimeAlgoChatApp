#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE_URL = "https://sentry.io";
const DEFAULT_ATTEMPTS = 18;
const DEFAULT_INTERVAL_MS = 10_000;
const EXPECTED_PROBE_FUNCTION = "createNativeSourceMapProbeError";
const EXPECTED_TRIGGER_KEYS = new Set(["platform", "candidate_build_id", "marker"]);
const CREDENTIAL_FIELD_PATTERN =
  /^(?:authorization[_-]?token|auth[_-]?token|sentry_auth_token|access[_-]?token|refresh[_-]?token)$/i;
const BEARER_TOKEN_PATTERN = /^bearer\s+[A-Za-z0-9._~+/-]{8,}$/i;
const CREDENTIAL_TEXT_PATTERN =
  /(?:\b(?:authorization|auth|access|refresh|sentry_auth)[_-]?token\b\s*(?::|=)\s*["']?[A-Za-z0-9._~+/-]{8,}|bearer\s+[A-Za-z0-9._~+/-]{8,})/i;

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

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Sentry verification setting: ${name}.`);
  }
  return value;
}

function duplicateJsonFields(raw) {
  let index = 0;
  const duplicates = new Set();

  function skipWhitespace() {
    while (/\s/.test(raw[index] ?? "")) index += 1;
  }

  function readString() {
    if (raw[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
      } else if (raw[index] === '"') {
        index += 1;
        try {
          return JSON.parse(raw.slice(start, index));
        } catch {
          return null;
        }
      } else {
        index += 1;
      }
    }
    return null;
  }

  function scanValue() {
    skipWhitespace();
    if (raw[index] === "{") return scanObject();
    if (raw[index] === "[") return scanArray();
    if (raw[index] === '"') return readString() !== null;

    const start = index;
    while (index < raw.length && !/[,\]}]/.test(raw[index])) index += 1;
    return index > start;
  }

  function scanObject() {
    if (raw[index] !== "{") return false;
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (raw[index] === "}") {
      index += 1;
      return true;
    }
    while (index < raw.length) {
      skipWhitespace();
      const key = readString();
      if (key === null) return false;
      if (keys.has(key)) duplicates.add(key);
      else keys.add(key);
      skipWhitespace();
      if (raw[index] !== ":") return false;
      index += 1;
      if (!scanValue()) return false;
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return true;
      }
      if (raw[index] !== ",") return false;
      index += 1;
    }
    return false;
  }

  function scanArray() {
    if (raw[index] !== "[") return false;
    index += 1;
    skipWhitespace();
    if (raw[index] === "]") {
      index += 1;
      return true;
    }
    while (index < raw.length) {
      if (!scanValue()) return false;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return true;
      }
      if (raw[index] !== ",") return false;
      index += 1;
    }
    return false;
  }

  if (!scanValue()) {
    throw new Error("evidence is not valid JSON");
  }
  skipWhitespace();
  if (index !== raw.length) {
    throw new Error("evidence is not valid JSON");
  }
  return [...duplicates];
}

function parseTrigger(triggerPath) {
  const seenKeys = new Set();
  const lines = readFileSync(triggerPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("trigger metadata is empty");
  }

  const trigger = Object.fromEntries(
    lines.map((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        throw new Error("trigger metadata is malformed");
      }
      const key = line.slice(0, separatorIndex);
      const value = line.slice(separatorIndex + 1).trim();
      if (!EXPECTED_TRIGGER_KEYS.has(key) || value.length === 0) {
        throw new Error("trigger metadata is malformed");
      }
      if (seenKeys.has(key)) {
        throw new Error("trigger metadata contains duplicate field(s)");
      }
      seenKeys.add(key);
      return [key, value];
    }),
  );

  if (seenKeys.size !== EXPECTED_TRIGGER_KEYS.size) {
    throw new Error("trigger metadata is malformed");
  }

  return trigger;
}

function escapeSentrySearchValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function normalizeSentryApiBaseUrl(apiBaseUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error("SENTRY_API_BASE_URL must be a valid HTTPS URL.");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("SENTRY_API_BASE_URL must use HTTPS.");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("SENTRY_API_BASE_URL must not contain credentials.");
  }
  if (!/^\/*$/.test(parsedUrl.pathname)) {
    throw new Error("SENTRY_API_BASE_URL must not include a path.");
  }
  parsedUrl.pathname = "/";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl;
}

function hasCredentialLikeContent(value) {
  if (typeof value === "string") {
    return (
      BEARER_TOKEN_PATTERN.test(value.trim()) ||
      CREDENTIAL_TEXT_PATTERN.test(value)
    );
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasCredentialLikeContent(entry));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.entries(value).some(([key, entryValue]) => {
    if (CREDENTIAL_FIELD_PATTERN.test(key) && typeof entryValue === "string") {
      return entryValue.trim().length > 0;
    }
    return hasCredentialLikeContent(entryValue);
  });
}

function hasCredentialLikeText(rawEvidence) {
  return CREDENTIAL_TEXT_PATTERN.test(rawEvidence);
}

function tagMap(event) {
  return new Map(
    (event.tags ?? []).map((tag) =>
      Array.isArray(tag) ? [tag[0], tag[1]] : [tag.key, tag.value],
    ),
  );
}

function eventRelease(event) {
  return typeof event.release === "string"
    ? event.release
    : event.release?.version;
}

function exceptionValues(event) {
  const exceptionEntry = (event.entries ?? []).find(
    (entry) => entry.type === "exception",
  );
  return exceptionEntry?.data?.values ?? event.exception?.values ?? [];
}

export function findReadableSourceMappedFrame(event) {
  const frames = exceptionValues(event).flatMap(
    (value) => value.stacktrace?.frames ?? [],
  );
  return [...frames].reverse().find((frame) => {
    const filename = frame.filename ?? frame.absPath ?? frame.abs_path ?? "";
    const functionName = frame.function ?? "";
    const inApp = frame.inApp ?? frame.in_app;
    const lineNumber = frame.lineNo ?? frame.lineno;
    const columnNumber = frame.colNo ?? frame.colno;
    const isSourceFile = /\.[cm]?[jt]sx?$/i.test(filename);
    const isBundle = /(?:index|main)\.(?:ios|android)?\.?bundle|\.jsbundle/i.test(
      filename,
    );
    return (
      inApp === true &&
      isSourceFile &&
      !isBundle &&
      typeof functionName === "string" &&
      functionName.includes(EXPECTED_PROBE_FUNCTION) &&
      Number.isInteger(lineNumber) &&
      lineNumber > 0 &&
      Number.isInteger(columnNumber) &&
      columnNumber > 0
    );
  });
}

export function validateNativeSentryEvent(event, expected) {
  const tags = tagMap(event);
  const release = eventRelease(event);
  const dist = event.dist;
  const frame = findReadableSourceMappedFrame(event);
  const failures = [];

  if (release !== expected.release) {
    failures.push(`release '${release ?? "missing"}'`);
  }
  if (dist !== expected.dist) {
    failures.push(`dist '${dist ?? "missing"}'`);
  }
  if (tags.get("mobile_sentry_probe") !== expected.marker) {
    failures.push("probe marker");
  }
  if (tags.get("mobile_platform") !== expected.platform) {
    failures.push("platform tag");
  }
  if (tags.get("mobile_candidate_build_id") !== expected.candidateBuildId) {
    failures.push("candidate build ID");
  }
  if (!frame) {
    failures.push("readable in-app source-mapped frame");
  }

  if (failures.length > 0) {
    throw new Error(
      `Sentry event did not match the installed candidate: ${failures.join(", ")}.`,
    );
  }

  return {
    status: "PASS",
    eventId: event.eventID ?? event.id,
    platform: expected.platform,
    candidateBuildId: expected.candidateBuildId,
    marker: expected.marker,
    release,
    dist,
    readableFrame: {
      filename: frame.filename ?? frame.absPath ?? frame.abs_path,
      function: frame.function,
      line: frame.lineNo ?? frame.lineno,
      column: frame.colNo ?? frame.colno,
    },
  };
}

export function verifyNativeSentryEvidence({
  evidencePath,
  triggerPath,
  expectedPlatform,
  expectedBuildId,
  expectedProbeMarker = "",
  expectedRelease = "",
  expectedDist = "",
}) {
  if (!evidencePath || !triggerPath || !expectedPlatform || !expectedBuildId) {
    throw new Error("missing evidence verification inputs");
  }

  const rawEvidence = readFileSync(evidencePath, "utf8");
  if (duplicateJsonFields(rawEvidence).length > 0) {
    throw new Error("duplicate JSON field(s)");
  }

  let evidence;
  try {
    evidence = JSON.parse(rawEvidence);
  } catch {
    throw new Error("evidence is not valid JSON");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("evidence must be a JSON object");
  }
  if (hasCredentialLikeText(rawEvidence) || hasCredentialLikeContent(evidence)) {
    throw new Error("evidence contains credential-like content");
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
    !frame.function.includes(EXPECTED_PROBE_FUNCTION) ||
    !Number.isInteger(frame.line) ||
    !Number.isInteger(frame.column)
  ) {
    throw new Error("readable source-mapped frame is missing");
  }

  return evidence;
}

async function sentryRequest(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "Authorization": ["Bearer", token].join(" "),
    },
  });
  if (!response.ok) {
    const error = new Error(
      `Sentry API request failed with status ${response.status}. Check the release environment token and project permissions.`,
    );
    error.retryable =
      response.status === 404 ||
      response.status === 429 ||
      response.status >= 500;
    throw error;
  }
  return response.json();
}

export async function verifyNativeSentryEvent({
  fetchImpl = fetch,
  apiBaseUrl,
  token,
  organization,
  project,
  expected,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const baseUrl = normalizeSentryApiBaseUrl(apiBaseUrl);
  const query = [
    `release:"${escapeSentrySearchValue(expected.release)}"`,
    `mobile_sentry_probe:"${escapeSentrySearchValue(expected.marker)}"`,
    `mobile_platform:"${escapeSentrySearchValue(expected.platform)}"`,
  ].join(" ");
  const listUrl = new URL(
    `/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/events/`,
    baseUrl,
  );
  listUrl.searchParams.set("full", "1");
  listUrl.searchParams.set("query", query);

  let lastValidationError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const summaries = await sentryRequest(fetchImpl, listUrl, token);
      for (const summary of Array.isArray(summaries) ? summaries : []) {
        const eventId = summary.eventID ?? summary.id;
        if (!eventId) continue;
        const detailUrl = new URL(
          `/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/events/${encodeURIComponent(eventId)}/`,
          baseUrl,
        );
        const event = await sentryRequest(fetchImpl, detailUrl, token);
        try {
          return validateNativeSentryEvent(event, expected);
        } catch (error) {
          lastValidationError = error;
        }
      }
    } catch (error) {
      if (!error.retryable) throw error;
      lastValidationError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw (
    lastValidationError ??
    new Error(
      "The controlled native JavaScript error did not arrive in Sentry before the verification timeout.",
    )
  );
}

function resolveEvidenceVerificationInputs(cliOptions, env) {
  const evidencePath = cliOptions.get("evidence-path") ?? env.SENTRY_EVIDENCE_PATH;
  return {
    evidencePath,
    triggerPath:
      cliOptions.get("trigger-path") ??
      env.SENTRY_TRIGGER_PATH ??
      (evidencePath ? join(dirname(evidencePath), "sentry-trigger.txt") : undefined),
    expectedPlatform: cliOptions.get("platform") ?? env.SENTRY_EXPECTED_PLATFORM,
    expectedBuildId: cliOptions.get("candidate-build-id") ?? env.SENTRY_EXPECTED_BUILD_ID,
    expectedProbeMarker:
      cliOptions.get("expected-probe-marker") ?? env.SENTRY_PROBE_MARKER ?? "",
    expectedRelease: cliOptions.get("expected-release") ?? env.SENTRY_EXPECTED_RELEASE ?? "",
    expectedDist: cliOptions.get("expected-dist") ?? env.SENTRY_EXPECTED_DIST ?? "",
  };
}

async function runEvidenceVerification(cliOptions, env = process.env) {
  verifyNativeSentryEvidence(resolveEvidenceVerificationInputs(cliOptions, env));
}

async function main(env = process.env) {
  const token = requiredEnv(env, "SENTRY_AUTH_TOKEN");
  const outputPath = requiredEnv(env, "SENTRY_EVIDENCE_PATH");
  const expected = {
    platform: requiredEnv(env, "SENTRY_EXPECTED_PLATFORM"),
    candidateBuildId: requiredEnv(env, "SENTRY_EXPECTED_BUILD_ID"),
    marker: requiredEnv(env, "SENTRY_PROBE_MARKER"),
    release: requiredEnv(env, "SENTRY_EXPECTED_RELEASE"),
    dist: requiredEnv(env, "SENTRY_EXPECTED_DIST"),
  };
  if (expected.platform !== "ios" && expected.platform !== "android") {
    throw new Error("SENTRY_EXPECTED_PLATFORM must be ios or android.");
  }

  const evidence = await verifyNativeSentryEvent({
    apiBaseUrl: env.SENTRY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
    token,
    organization: env.SENTRY_ORG?.trim() || "lisagorewitdecker-06",
    project: env.SENTRY_PROJECT?.trim() || "react-native",
    expected,
    attempts: Number(env.SENTRY_VERIFY_ATTEMPTS || DEFAULT_ATTEMPTS),
    intervalMs: Number(env.SENTRY_VERIFY_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
  console.log(
    `Verified readable ${expected.platform} source maps for the installed native candidate.`,
  );
}

function hasRemoteVerificationInputs(env) {
  return typeof env.SENTRY_AUTH_TOKEN === "string" && env.SENTRY_AUTH_TOKEN.trim() !== "";
}

function isEvidenceVerificationRequest(cliOptions, env) {
  return (
    cliOptions.has("evidence-path") ||
    cliOptions.has("trigger-path") ||
    Boolean(env.SENTRY_EVIDENCE_PATH) ||
    Boolean(env.SENTRY_TRIGGER_PATH)
  );
}

function canFallbackToRemoteVerification(error, cliOptions, env) {
  const { evidencePath, triggerPath } = resolveEvidenceVerificationInputs(cliOptions, env);
  return (
    Boolean(evidencePath) &&
    !cliOptions.has("evidence-path") &&
    !cliOptions.has("trigger-path") &&
    hasRemoteVerificationInputs(env) &&
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT" &&
    !existsSync(evidencePath) &&
    (!triggerPath || !existsSync(triggerPath))
  );
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const cliOptions = parseArgs(argv);
  if (isEvidenceVerificationRequest(cliOptions, env)) {
    try {
      await runEvidenceVerification(cliOptions, env);
      return;
    } catch (error) {
      if (!canFallbackToRemoteVerification(error, cliOptions, env)) {
        throw error;
      }
    }
  }
  await main(env);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
