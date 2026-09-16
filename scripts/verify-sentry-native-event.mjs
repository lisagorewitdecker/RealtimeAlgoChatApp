#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE_URL = "https://sentry.io";
const DEFAULT_ATTEMPTS = 18;
const DEFAULT_INTERVAL_MS = 10_000;
const EXPECTED_PROBE_FUNCTION = "createNativeSourceMapProbeError";

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Sentry verification setting: ${name}.`);
  }
  return value;
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

async function sentryRequest(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
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
  const query = [
    `release:"${expected.release.replaceAll('"', '\\"')}"`,
    `mobile_sentry_probe:${expected.marker}`,
    `mobile_platform:${expected.platform}`,
  ].join(" ");
  const listUrl = new URL(
    `/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/events/`,
    apiBaseUrl,
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
          apiBaseUrl,
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
