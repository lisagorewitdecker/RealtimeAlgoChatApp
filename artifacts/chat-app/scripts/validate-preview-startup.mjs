import { createServer } from "node:net";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findDuplicateJsonObjectKeys,
  isJsonEvidenceLimitError,
} from "../../../scripts/find-duplicate-json-object-keys.mjs";
import { readBoundedTextFile } from "../../../scripts/read-bounded-text.mjs";
import {
  MAX_PREVIEW_TIMEOUT_MS,
  READY_MARKERS,
  parsePreviewTimeout,
} from "./preview-startup-shared.mjs";

export { MAX_PREVIEW_TIMEOUT_MS, READY_MARKERS, parsePreviewTimeout };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 60_000;
const DEFAULT_PUBLIC_PREVIEW_TIMEOUT_MS = 15_000;
const STARTUP_FAILURE_GRACE_MS = 250;
const MAX_STARTUP_DIAGNOSTIC_LENGTH = 512;
const MAX_STARTUP_FAILURE_LINE_LENGTH = 320;
const MAX_STARTUP_SUMMARY_LENGTH = 512;
const MAX_STARTUP_LIBRARY_DETAIL_LENGTH = 192;
const MAX_RECORDED_STARTUP_OUTPUT_LENGTH = 16_384;
const MAX_RECORDED_STARTUP_LINE_LENGTH = 1_024;
const STARTUP_DIAGNOSTIC_PREFIX = "Expo preview startup error: ";
const HANDOFF_FAILURE_PHASES = Object.freeze([
  {
    label: "public manifest",
    matches: [
      "Public Expo preview manifest check failed",
      "Preview handoff preflight failed at the public manifest probe.",
    ],
  },
  {
    label: "local handoff",
    matches: [
      "Local Expo Go manifest/bundle probe failed",
      "Preview handoff preflight failed at the local manifest/bundle probe.",
    ],
  },
]);
const HANDOFF_PLATFORM_CONFIG = {
  android: {
    schema: "android-preview-handoff-preflight/v1",
    manifestPlatform: "android",
    displayName: "Android",
    phoneDescription: "a physical Android phone",
  },
  ios: {
    schema: "ios-preview-handoff-preflight/v1",
    manifestPlatform: "ios",
    displayName: "iOS",
    phoneDescription: "a physical iPhone",
  },
};
const HANDOFF_BOUNDARIES = Object.freeze([
  "publicManifestReachability",
  "localHandoffProbe",
  "expoGoLaunch",
  "serverNativeRequestEvidence",
]);
const HANDOFF_ALLOWED_STATUSES = Object.freeze({
  publicManifestReachability: new Set(["PASS", "FAIL", "NOT_RUN"]),
  localHandoffProbe: new Set(["PASS", "FAIL", "NOT_RUN"]),
  expoGoLaunch: new Set(["NOT_ASSESSED"]),
  serverNativeRequestEvidence: new Set(["NOT_ASSESSED"]),
});
const HANDOFF_EVIDENCE_PATTERNS = Object.freeze({
  publicManifestReachability: {
    PASS: /^public manifest HTTP 200 \(\d+ bytes\)$/,
    FAIL: /^Public manifest probe failed — no successful probe result was recorded$/,
    NOT_RUN:
      /^Public manifest probe not run — no successful probe result was recorded$/,
  },
  localHandoffProbe: {
    PASS:
      /^manifest HTTP 200 \(\d+ bytes\); bundle HTTP 200 \(\d+ bytes\)$/,
    FAIL:
      /^Local manifest\/bundle probe failed — no successful probe result was recorded$/,
    NOT_RUN:
      /^Local manifest\/bundle probe not run — no successful probe result was recorded$/,
  },
  expoGoLaunch: {
    NOT_ASSESSED: (platformConfig) =>
      new RegExp(
        `^Requires ${platformConfig.phoneDescription} running stock Expo Go\\.$`,
      ),
  },
  serverNativeRequestEvidence: {
    NOT_ASSESSED:
      /^Requires filtered Metro or API evidence from that physical Expo Go session\.$/,
  },
});
const DEV_SERVER_SIGN_IN_STATUSES = Object.freeze({
  signedIn: "SIGNED_IN",
  anonymous: "ANONYMOUS",
});
const STARTUP_FAILURES = [
  /error while loading shared libraries:/i,
  /cannot open shared object file/i,
  /library not loaded:/i,
  /cannot proceed because [^\r\n]+ was not found/i,
  /(?:error|failed|unable|cannot).{0,80}(?:react native )?devtools/i,
  /(?:react native )?devtools.{0,80}(?:error|failed|unable|cannot|could not|couldn't)/i,
];
const LOADER_FAILURES = [
  /error while loading shared libraries:/i,
  /cannot open shared object file/i,
  /library not loaded:/i,
  /cannot proceed because [^\r\n]+ was not found/i,
];
const UNRECOGNIZED_LOADER_FAILURES = [
  /(?:react native )?devtools.{0,120}(?:launcher|loader|binary).{0,120}(?:exited|terminated|error|failed|unable|cannot|could not|status)/i,
  /(?:launcher|loader).{0,120}(?:react native )?devtools.{0,120}(?:exited|terminated|error|failed|unable|cannot|could not|status)/i,
];
export const LOADER_COMPATIBILITY_MAINTENANCE_MESSAGE =
  "Expo preview loader wording changed. Update STARTUP_FAILURES and " +
  "MISSING_LIBRARY_PATTERNS, then refresh the versioned loader samples " +
  "with pnpm run refresh:preview-loader-evidence before relying on this " +
  "diagnostic.";
const STARTUP_TEST_FIXTURES = new Set([
  "handoff-server",
  "handoff-server-stall-manifest",
  "handoff-server-stall-bundle",
  "missing-runtime-library",
  "missing-runtime-library-dyld",
  "missing-runtime-library-windows",
  "missing-runtime-library-long-path",
  "missing-runtime-library-dyld-long-path",
  "missing-runtime-library-windows-long-path",
  "missing-runtime-library-spaced",
  "missing-runtime-library-dyld-quoted",
  "missing-runtime-library-windows-quoted",
  "missing-runtime-library-dyld-quoted-long-path",
  "missing-runtime-library-windows-quoted-long-path",
  "missing-runtime-library-malformed-quotes",
  "missing-runtime-library-malformed-control",
  "missing-runtime-library-malformed-trailing",
  "missing-runtime-library-malformed-followed-by-valid",
]);
const MISSING_LIBRARY_PATH = String.raw`[A-Za-z0-9._+~ /\\:[\]-]`;
const MISSING_LIBRARY_CAPTURE = String.raw`(?:(["'])([^"'\u0000-\u001f\u007f]+)\1|(${MISSING_LIBRARY_PATH}+?))`;
const MISSING_LIBRARY_DYLD_CAPTURE = String.raw`(?:(["'])([^"'\u0000-\u001f\u007f]+)\1|(${MISSING_LIBRARY_PATH}+))`;
const MISSING_LIBRARY_BASENAME = /(?:^|[\\/])[^/\\\s:]+\.(?:dylib|so(?:\.\d+)?|dll)$/i;
const MISSING_LIBRARY_PATTERNS = [
  new RegExp(
    String.raw`error while loading shared libraries:\s*${MISSING_LIBRARY_CAPTURE}\s*:\s*cannot open shared object file(?:\s*:\s*no such file or directory)?\s*$`,
    "i",
  ),
  new RegExp(
    String.raw`library not loaded:\s*${MISSING_LIBRARY_DYLD_CAPTURE}\s*$`,
    "i",
  ),
  new RegExp(
    String.raw`cannot proceed because\s+${MISSING_LIBRARY_CAPTURE}\s+was not found(?:\.\s*(?:reinstalling the program may fix this problem\.)?)?\s*$`,
    "i",
  ),
];

function findStartupFailure(output) {
  const lines = output.split(/\r?\n/);
  return (
    lines.find((line) =>
      STARTUP_FAILURES.some((pattern) => pattern.test(line)),
    ) ?? null
  );
}

function findLoaderFailure(output) {
  const lines = output.split(/\r?\n/);
  return (
    lines.find((line) => LOADER_FAILURES.some((pattern) => pattern.test(line))) ??
    null
  );
}

function findUnrecognizedLoaderFailure(output) {
  const lines = output.split(/\r?\n/);
  return (
    lines.find((line) =>
      UNRECOGNIZED_LOADER_FAILURES.some((pattern) => pattern.test(line)),
    ) ?? null
  );
}

function sanitizeStartupDiagnostic(value, maxLength) {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function redactStartupAuthorization(value) {
  return value.replace(
    /(?<!redacted )\b(?:authorization|proxy-authorization)\s*:?.*$/gi,
    "[redacted authorization]",
  );
}

function redactKnownStartupFailureSecrets(value) {
  const loaderStart = value.search(
    /(?:error while loading shared libraries:|library not loaded:|cannot proceed because\b)/i,
  );
  if (loaderStart < 0) return value;

  const prefix = value.slice(0, loaderStart);
  const loaderFailure = value.slice(loaderStart);
  return `${prefix}${loaderFailure
    .replace(
      /\s+(?:password|authorization|proxy-authorization|token)\s*[:=]\s*\S.*$/i,
      "",
    )
    .replace(/\s+\[redacted (?:credential|authorization)\].*$/i, "")}`;
}

function normalizeLoaderFailureForMatching(value) {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u0007\s*$/g, "");
}

function findMissingLibrary(output) {
  for (const line of output.split(/\r?\n/)) {
    const normalizedLine = normalizeLoaderFailureForMatching(
      redactKnownStartupFailureSecrets(line),
    );
    for (const pattern of MISSING_LIBRARY_PATTERNS) {
      const match = normalizedLine.match(pattern);
      const missingLibrary = (match?.[2] ?? match?.[3])?.trim();
      if (missingLibrary && MISSING_LIBRARY_BASENAME.test(missingLibrary)) {
        return missingLibrary;
      }
    }
  }
  return null;
}

function compactStartupLibraryPath(path) {
  if (path.length <= MAX_STARTUP_LIBRARY_DETAIL_LENGTH) return path;

  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const libraryIdentifier =
    separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
  const ellipsis = "…";
  const preservedPrefixLength = Math.max(
    0,
    MAX_STARTUP_LIBRARY_DETAIL_LENGTH -
      ellipsis.length -
      libraryIdentifier.length -
      (separatorIndex >= 0 ? 1 : 0),
  );

  if (separatorIndex < 0 || libraryIdentifier.length >= MAX_STARTUP_LIBRARY_DETAIL_LENGTH) {
    return `${ellipsis}${path.slice(-MAX_STARTUP_LIBRARY_DETAIL_LENGTH + ellipsis.length)}`;
  }

  return `${path.slice(0, preservedPrefixLength)}${ellipsis}${path.slice(separatorIndex)}`;
}

function formatStartupFailure(output) {
  const failure = findStartupFailure(output);
  const loaderFailure = findLoaderFailure(output);
  if (failure) {
    const isLoaderFailure = Boolean(loaderFailure);
    const safeFailure = isLoaderFailure
      ? redactKnownStartupFailureSecrets(failure)
      : failure;
    const missingLibrary = loaderFailure
      ? findMissingLibrary(loaderFailure)
      : null;
    if (isLoaderFailure && !missingLibrary) {
      return `${STARTUP_DIAGNOSTIC_PREFIX}${LOADER_COMPATIBILITY_MAINTENANCE_MESSAGE}`;
    }

    const fullFailureDetail = sanitizeStartupDiagnostic(
      safeFailure,
      MAX_STARTUP_FAILURE_LINE_LENGTH,
    );
    const redactedFailureDetail = redactStartupAuthorization(fullFailureDetail);
    const libraryDetail =
      missingLibrary &&
      (!fullFailureDetail.includes(missingLibrary) ||
        missingLibrary.length > MAX_STARTUP_LIBRARY_DETAIL_LENGTH)
        ? ` (missing runtime library: ${compactStartupLibraryPath(missingLibrary)})`
        : "";

    const failureLength = Math.min(
      redactedFailureDetail.length,
      Math.max(
        0,
        MAX_STARTUP_DIAGNOSTIC_LENGTH -
          STARTUP_DIAGNOSTIC_PREFIX.length -
          libraryDetail.length,
      ),
    );
    const failureDetail = redactedFailureDetail.slice(0, failureLength);

    return `${STARTUP_DIAGNOSTIC_PREFIX}${sanitizeStartupDiagnostic(
      `${failureDetail}${libraryDetail}`,
      MAX_STARTUP_DIAGNOSTIC_LENGTH - STARTUP_DIAGNOSTIC_PREFIX.length,
    )}`;
  }

  const unrecognizedLoaderFailure = findUnrecognizedLoaderFailure(output);
  if (!unrecognizedLoaderFailure) return null;

  return `${STARTUP_DIAGNOSTIC_PREFIX}${LOADER_COMPATIBILITY_MAINTENANCE_MESSAGE}`;
}

function sanitizeStartupSummaryDiagnostic(value) {
  return redactStartupAuthorization(
    sanitizeStartupDiagnostic(value, MAX_STARTUP_SUMMARY_LENGTH).replace(
      /https?:\/\/\S+/gi,
      "[redacted URL]",
    ),
  )
    .replace(
      /\b(?:api[_-]?key|credential|password|passwd|secret|token)\s*(?:[=:]\s*|\s+)\S+/gi,
      "[redacted credential]",
    )
    .replace(/[`*]/g, "")
    .slice(0, MAX_STARTUP_SUMMARY_LENGTH);
}

function sanitizeRecordedStartupOutput(value) {
  const sanitizedLines = value
    .split(/\r?\n/)
    .map((line) =>
      sanitizeStartupSummaryDiagnostic(line)
        .replace(/\/(?:Users|home)\/[^\r\n]+/g, (path) => {
          const prefix = path.startsWith("/Users/") ? "/Users/" : "/home/";
          const libraryName = path.match(
            /[^/\\\s]+?\.(?:dylib|so(?:\.\d+)?|dll)\b/i,
          )?.[0];
          if (!libraryName) return `${prefix}[redacted]`;
          const suffix = path.slice(path.indexOf(libraryName) + libraryName.length);
          return `${prefix}[redacted]/${libraryName}${suffix}`;
        })
        .replace(
          /[A-Za-z]:\\(?:Users|home)\\[^\r\n]+|[A-Za-z]:\\a\\[^\\\r\n]+\\[^\r\n]+/g,
          (path) => {
            const libraryName = path.match(
              /[^/\\\s]+?\.(?:dylib|so(?:\.\d+)?|dll)\b/i,
            )?.[0];
            if (!libraryName) return `${path.slice(0, 3)}[redacted]`;
            const suffix = path.slice(path.indexOf(libraryName) + libraryName.length);
            return `${path.slice(0, 3)}[redacted]\\${libraryName}${suffix}`;
          },
        )
        .slice(0, MAX_RECORDED_STARTUP_LINE_LENGTH),
    )
    .join("\n");

  return sanitizedLines.slice(0, MAX_RECORDED_STARTUP_OUTPUT_LENGTH);
}

function recordStartupOutput(recordLog, output) {
  if (!recordLog) return;
  writeFileSync(resolve(recordLog), sanitizeRecordedStartupOutput(output), "utf8");
}

function getHandoffFailurePhase(message) {
  return (
    HANDOFF_FAILURE_PHASES.find(({ matches }) =>
      matches.some((prefix) => message.startsWith(prefix)),
    )?.label ?? null
  );
}

export function formatStartupFailureSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  const handoffFailurePhase = getHandoffFailurePhase(message);
  if (handoffFailurePhase) {
    return (
      "### Expo preview startup\n\n" +
      "**Status:** FAIL\n\n" +
      `**Failed phase:** ${handoffFailurePhase}\n\n`
    );
  }

  const startupFailure =
    message.startsWith("Expo preview startup error:") ||
    message.startsWith("Public Expo preview manifest URL ")
    ? message
    : formatStartupFailure(message);
  const diagnostic = startupFailure
    ? sanitizeStartupSummaryDiagnostic(startupFailure)
    : "Preview startup could not be confirmed. See the workflow log for details.";

  return (
    "### Expo preview startup\n\n" +
    "**Status:** FAIL\n\n" +
    `**Diagnosis:** ${diagnostic}\n\n`
  );
}

async function writeStartupFailureSummary(error) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  try {
    await appendFile(summaryPath, formatStartupFailureSummary(error), "utf8");
  } catch {
    console.error("Could not write the preview startup failure summary.");
  }
}

function isStartupValidationInvocation(argv) {
  if (argv.includes("--validate-record")) return false;

  const logFileIndex = argv.indexOf("--log-file");
  if (logFileIndex === -1) return true;

  const logFile = argv[logFileIndex + 1];
  return Boolean(logFile && !logFile.startsWith("--"));
}

function formatRequestOutcome(stage, response, byteLength) {
  return `${stage} HTTP ${response.status} (${byteLength} bytes)`;
}

function safePreflightFailure(status) {
  return `${status} — no successful probe result was recorded`;
}

function formatRecordWriteFailure(phase) {
  const boundary =
    phase === "public"
      ? "public manifest probe"
      : "local manifest/bundle probe";
  return (
    `Preview handoff preflight failed at the ${boundary}. ` +
    "The failed-boundary record could not be saved. " +
    "Recovery: rerun with --record-output set to a writable JSON file, " +
    "or omit --record-output."
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function invalidHandoffRecord(message) {
  throw new Error(`Preview handoff preflight JSON ${message}.`);
}

export function validateHandoffPreflightRecord(record) {
  const platformConfig =
    isPlainObject(record) && HANDOFF_PLATFORM_CONFIG[record.platform];
  if (
    !isPlainObject(record) ||
    !platformConfig ||
    !hasExactKeys(record, ["schema", "platform", "boundaries"]) ||
    record.schema !== platformConfig.schema ||
    !isPlainObject(record.boundaries) ||
    !hasExactKeys(record.boundaries, HANDOFF_BOUNDARIES)
  ) {
    invalidHandoffRecord("does not match the expected redacted schema");
  }

  for (const boundary of HANDOFF_BOUNDARIES) {
    const result = record.boundaries[boundary];
    if (
      !isPlainObject(result) ||
      !hasExactKeys(result, ["status", "evidence"]) ||
      typeof result.status !== "string" ||
      !HANDOFF_ALLOWED_STATUSES[boundary].has(result.status)
    ) {
      invalidHandoffRecord(`has an invalid ${boundary} boundary`);
    }
    const evidencePattern = HANDOFF_EVIDENCE_PATTERNS[boundary][result.status];
    const resolvedEvidencePattern =
      typeof evidencePattern === "function"
        ? evidencePattern(platformConfig)
        : evidencePattern;
    if (
      typeof result.evidence !== "string" ||
      !resolvedEvidencePattern?.test(result.evidence)
    ) {
      invalidHandoffRecord(`has unsafe evidence for the ${boundary} boundary`);
    }
  }

  if (
    record.boundaries.localHandoffProbe.status !== "NOT_RUN" &&
    record.boundaries.publicManifestReachability.status !== "PASS"
  ) {
    invalidHandoffRecord(
      "cannot report a local probe without public reachability",
    );
  }

  return record;
}

export async function readAndValidateHandoffPreflight(outputPath) {
  let source;
  try {
    source = await readBoundedTextFile(resolve(outputPath));
  } catch (error) {
    if (isJsonEvidenceLimitError(error)) {
      throw new Error(
        "Preview handoff preflight JSON exceeds the release evidence size limit.",
      );
    }
    throw new Error("Preview handoff preflight JSON could not be read.");
  }

  try {
    if (findDuplicateJsonObjectKeys(source).length > 0) {
      throw new Error("Preview handoff preflight JSON contains duplicate fields.");
    }
  } catch (error) {
    if (isJsonEvidenceLimitError(error)) {
      throw new Error(
        "Preview handoff preflight JSON exceeds the release evidence size or nesting limit.",
      );
    }
    throw error;
  }

  let record;
  try {
    record = JSON.parse(source);
  } catch {
    throw new Error("Preview handoff preflight JSON is not valid JSON.");
  }
  return validateHandoffPreflightRecord(record);
}

export function createHandoffPreflightRecord({
  platform = "android",
  publicManifest = null,
  localHandoff = null,
  publicManifestFailed = false,
  localHandoffFailed = false,
} = {}) {
  const platformConfig = HANDOFF_PLATFORM_CONFIG[platform];
  if (!platformConfig) {
    throw new Error(
      `Unsupported preview handoff platform "${platform}". Expected ios or android.`,
    );
  }

  return {
    schema: platformConfig.schema,
    platform,
    boundaries: {
      publicManifestReachability: {
        status: publicManifest
          ? "PASS"
          : publicManifestFailed
            ? "FAIL"
            : "NOT_RUN",
        evidence:
          publicManifest?.outcome ??
          safePreflightFailure(
            publicManifestFailed
              ? "Public manifest probe failed"
              : "Public manifest probe not run",
          ),
      },
      localHandoffProbe: {
        status: localHandoff ? "PASS" : localHandoffFailed ? "FAIL" : "NOT_RUN",
        evidence: localHandoff
          ? `${localHandoff.manifest}; ${localHandoff.bundle}`
          : safePreflightFailure(
              localHandoffFailed
                ? "Local manifest/bundle probe failed"
                : "Local manifest/bundle probe not run",
            ),
      },
      expoGoLaunch: {
        status: "NOT_ASSESSED",
        evidence: `Requires ${platformConfig.phoneDescription} running stock Expo Go.`,
      },
      serverNativeRequestEvidence: {
        status: "NOT_ASSESSED",
        evidence:
          "Requires filtered Metro or API evidence from that physical Expo Go session.",
      },
    },
  };
}

export function formatHandoffPreflight(record) {
  const { boundaries } = record;
  const platformConfig = HANDOFF_PLATFORM_CONFIG[record.platform ?? "android"];
  if (!platformConfig) {
    throw new Error(
      `Unsupported preview handoff platform "${record.platform}". Expected ios or android.`,
    );
  }

  return [
    `${platformConfig.displayName} preview handoff preflight (public and local probes only):`,
    `public_manifest_reachability=${boundaries.publicManifestReachability.status}; evidence=${boundaries.publicManifestReachability.evidence}`,
    `local_handoff_probe=${boundaries.localHandoffProbe.status}; evidence=${boundaries.localHandoffProbe.evidence}`,
    `expo_go_launch=${boundaries.expoGoLaunch.status}; evidence=${boundaries.expoGoLaunch.evidence}`,
    `server_native_request_evidence=${boundaries.serverNativeRequestEvidence.status}; evidence=${boundaries.serverNativeRequestEvidence.evidence}`,
  ].join("\n");
}

export async function writeHandoffPreflight(outputPath, record) {
  validateHandoffPreflightRecord(record);
  await writeFile(
    resolve(outputPath),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

function publicPreviewRecoveryMessage() {
  return (
    "Restart or repair the managed Chat App/Expo workflow, then rerun the " +
    "preview handoff preflight before starting a phone session."
  );
}

/**
 * Expo CLI advertises the account its dev server is signed into through
 * `extra.expoGo.username`; Expo Go 57 on iOS compares that account with its
 * own before loading the project. An anonymous manifest omits the field.
 * Only the presence of the field is inspected so no account identifier or
 * session value ever reaches validation output.
 */
export function manifestHasSignedInDeveloper(manifest) {
  const username = manifest?.extra?.expoGo?.username;
  return (
    typeof username === "string" &&
    username.length > 0 &&
    username !== "anonymous"
  );
}

function hasExpoSessionSecret(environment) {
  const secret = environment.REPLIT_EXPO_SESSION_SECRET;
  return typeof secret === "string" && secret.length > 0;
}

function describeManifestSources(sources) {
  return sources.length === 2 ? `${sources[0]} and ${sources[1]}` : sources[0];
}

export function classifyDevServerSignIn(
  { localSignedIn, publicSignedIn },
  environment = process.env,
) {
  // Anything short of an explicit `true` counts as anonymous so a missing
  // probe result can never make this gate pass by accident.
  const anonymousSources = [];
  if (publicSignedIn !== true) anonymousSources.push("public");
  if (localSignedIn !== true) anonymousSources.push("local");
  const secretConfigured = hasExpoSessionSecret(environment);

  if (anonymousSources.length === 0) {
    return {
      status: DEV_SERVER_SIGN_IN_STATUSES.signedIn,
      severity: "pass",
      evidence:
        "public and local Expo Go manifests both carry a signed-in Expo account (extra.expoGo.username present)",
    };
  }

  const anonymousDescription = describeManifestSources(anonymousSources);
  if (secretConfigured) {
    return {
      status: DEV_SERVER_SIGN_IN_STATUSES.anonymous,
      severity: "fail",
      evidence:
        `REPLIT_EXPO_SESSION_SECRET is set but the ${anonymousDescription} Expo Go ` +
        "manifest is anonymous (no extra.expoGo.username). iOS Expo Go 57 only " +
        "loads the app from a dev server signed into the same Expo account, so " +
        "the dev script's create-launch login step is missing or failed. Check " +
        'the Chat App workflow log for the "Logged in as" line, then restart ' +
        "the managed Chat App/Expo workflow.",
    };
  }

  return {
    status: DEV_SERVER_SIGN_IN_STATUSES.anonymous,
    severity: "warn",
    evidence:
      `REPLIT_EXPO_SESSION_SECRET is unset, so the ${anonymousDescription} Expo Go ` +
      "manifest is anonymous (no extra.expoGo.username). iOS Expo Go 57 cannot " +
      "load the app until the workspace supplies the managed Expo session.",
  };
}

export function formatDevServerSignIn(signIn) {
  return `dev_server_sign_in=${signIn.status}; evidence=${signIn.evidence}`;
}

export function getPublicPreviewManifestUrl(environment = process.env) {
  const configuredSetting =
    environment.PREVIEW_PUBLIC_URL != null
      ? "PREVIEW_PUBLIC_URL"
      : "REPLIT_EXPO_DEV_DOMAIN";
  const configuredUrl =
    environment.PREVIEW_PUBLIC_URL ?? environment.REPLIT_EXPO_DEV_DOMAIN;
  if (!configuredUrl) {
    throw new Error(
      "Public Expo preview manifest URL is not configured. Set " +
        "REPLIT_EXPO_DEV_DOMAIN or PREVIEW_PUBLIC_URL before running the live " +
        "preview handoff preflight.",
    );
  }

  let url;
  try {
    url = new URL(
      configuredUrl.includes("://") ? configuredUrl : `https://${configuredUrl}`,
    );
  } catch {
    throw new Error(
      `Public Expo preview manifest URL configuration from ${configuredSetting} ` +
        "is invalid. Set " +
        `${configuredSetting} to a valid HTTPS URL ` +
        "before running the live preview handoff preflight.",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error("Public Expo preview manifest URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error(
      "Public Expo preview manifest URL must not contain credentials.",
    );
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function usesStartupTestFixture(
  environment = process.env,
  { includeOutputOverride = true } = {},
) {
  return (
    STARTUP_TEST_FIXTURES.has(environment.PREVIEW_STARTUP_TEST_FIXTURE) ||
    (includeOutputOverride && environment.PREVIEW_STARTUP_TEST_OUTPUT != null)
  );
}

export function validatePreviewConfiguration(environment = process.env) {
  if (usesStartupTestFixture(environment, { includeOutputOverride: false })) {
    return;
  }
  getPublicPreviewManifestUrl(environment);
}

export async function requestPublicPreviewManifest(
  timeoutMs,
  environment = process.env,
  platform = "android",
) {
  const platformConfig = HANDOFF_PLATFORM_CONFIG[platform];
  if (!platformConfig) {
    throw new Error(
      `Unsupported preview handoff platform "${platform}". Expected ios or android.`,
    );
  }

  const url = getPublicPreviewManifestUrl(environment);
  const deadline = Date.now() + timeoutMs;
  const headers = {
    Accept: "application/json",
    "expo-platform": platformConfig.manifestPlatform,
    "user-agent": "Expo/57.0.0 (preview-validation)",
  };

  let response;
  let body;
  try {
    ({ response, body } = await requestWithDeadline(
      url,
      { headers },
      deadline,
      (manifestResponse) => manifestResponse.text(),
      `${timeoutMs}ms configured public preview deadline`,
      "public manifest",
    ));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Public Expo preview manifest check failed before a response: ${detail}. ` +
        publicPreviewRecoveryMessage(),
    );
  }

  const outcome = formatRequestOutcome(
    "public manifest",
    response,
    Buffer.byteLength(body),
  );
  if (response.status !== 200) {
    throw new Error(
      `Public Expo preview manifest check failed: ${outcome}. ` +
        publicPreviewRecoveryMessage(),
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error(
      `Public Expo preview manifest check failed: ${outcome}; manifest returned invalid JSON. ` +
        publicPreviewRecoveryMessage(),
    );
  }

  if (
    !manifest ||
    typeof manifest !== "object" ||
    typeof manifest.launchAsset?.url !== "string" ||
    manifest.launchAsset.url.length === 0
  ) {
    throw new Error(
      `Public Expo preview manifest check failed: ${outcome}; manifest did not provide a launch asset URL. ` +
        publicPreviewRecoveryMessage(),
    );
  }

  const signedInDeveloper = manifestHasSignedInDeveloper(manifest);
  return { outcome, signedInDeveloper };
}

function localBundleUrl(port, launchAssetUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(launchAssetUrl);
  } catch {
    throw new Error("Expo Go manifest launch asset URL is invalid.");
  }

  return `http://127.0.0.1:${port}${parsedUrl.pathname}${parsedUrl.search}`;
}

async function requestWithDeadline(
  url,
  options,
  deadline,
  readBody,
  deadlineDescription = "configured request deadline",
  resourceDescription = "request",
) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("request deadline exceeded before request started");
  }

  const controller = new AbortController();
  let deadlineAbortError;
  const abortPromise = new Promise((resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          deadlineAbortError ??
            new Error(`request aborted (${deadlineDescription})`),
        ),
      { once: true },
    );
  });
  const abortTimer = setTimeout(() => {
    deadlineAbortError = new Error(
      `request aborted by deadline (${deadlineDescription})`,
    );
    controller.abort(deadlineAbortError);
  }, remainingMs);

  let headersReceived = false;
  try {
    const response = await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      abortPromise,
    ]);
    headersReceived = true;
    const body = await Promise.race([readBody(response), abortPromise]);
    return { response, body };
  } catch (error) {
    if (deadlineAbortError) {
      if (headersReceived) {
        throw new Error(
          `${resourceDescription} response headers received but body did not ` +
            `complete before ${deadlineDescription}: ${deadlineAbortError.message}`,
        );
      }
      throw deadlineAbortError;
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}

const LOCAL_HANDOFF_RETRY_PAUSE_MS = 250;

export async function requestLocalHandoffProbe(
  port,
  timeoutMs,
  platform = "android",
) {
  const platformConfig = HANDOFF_PLATFORM_CONFIG[platform];
  if (!platformConfig) {
    throw new Error(
      `Unsupported preview handoff platform "${platform}". Expected ios or android.`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const headers = {
    "expo-platform": platformConfig.manifestPlatform,
    "user-agent": "Expo/57.0.0 (preview-validation)",
  };
  let lastError = null;

  while (Date.now() < deadline) {
    const outcome = {
      manifest: null,
      bundle: null,
    };

    try {
      const manifestRequest = await requestWithDeadline(
        `http://127.0.0.1:${port}/`,
        { headers },
        deadline,
        (response) => response.text(),
        `${timeoutMs}ms configured local handoff deadline`,
        "manifest",
      );
      const { response: manifestResponse, body: manifestBody } =
        manifestRequest;
      outcome.manifest = formatRequestOutcome(
        "manifest",
        manifestResponse,
        Buffer.byteLength(manifestBody),
      );

      if (!manifestResponse.ok) {
        throw new Error(outcome.manifest);
      }

      let manifest;
      try {
        manifest = JSON.parse(manifestBody);
      } catch {
        throw new Error("manifest returned invalid JSON");
      }

      const launchAssetUrl = manifest?.launchAsset?.url;
      if (typeof launchAssetUrl !== "string" || launchAssetUrl.length === 0) {
        throw new Error("manifest did not provide a launch asset URL");
      }

      const bundleRequest = await requestWithDeadline(
        localBundleUrl(port, launchAssetUrl),
        { headers },
        deadline,
        (response) => response.arrayBuffer(),
        `${timeoutMs}ms configured local handoff deadline`,
        "bundle",
      );
      const { response: bundleResponse, body: bundleBody } = bundleRequest;
      outcome.bundle = formatRequestOutcome(
        "bundle",
        bundleResponse,
        bundleBody.byteLength,
      );

      if (!bundleResponse.ok || bundleBody.byteLength === 0) {
        throw new Error(outcome.bundle);
      }

      return {
        ...outcome,
        launchAssetPath: new URL(launchAssetUrl).pathname,
        signedInDeveloper: manifestHasSignedInDeveloper(manifest),
      };
    } catch (error) {
      lastError = new Error(
        [
          "Local Expo Go manifest/bundle probe failed:",
          outcome.manifest ?? "manifest request did not complete",
          outcome.bundle ?? "bundle request did not complete",
          error instanceof Error ? error.message : String(error),
          publicPreviewRecoveryMessage(),
        ].join(" "),
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      if (remainingMs <= LOCAL_HANDOFF_RETRY_PAUSE_MS) {
        // The deadline falls inside the next pause. Wait it out instead of
        // starting an attempt that has no time to complete: a timer can wake
        // a fraction of a millisecond before Date.now() reaches the deadline,
        // and such an attempt would replace the last real outcome with
        // "request aborted by deadline" while leaving a half-finished
        // manifest request behind.
        await delay(remainingMs);
        while (Date.now() < deadline) {
          await delay(1);
        }
        break;
      }
      await delay(LOCAL_HANDOFF_RETRY_PAUSE_MS);
    }
  }

  throw (
    lastError ??
    new Error(
      "Local Expo Go manifest/bundle probe failed before a request completed.",
    )
  );
}

export function validatePreviewOutput(output) {
  const startupFailure = formatStartupFailure(output);
  if (startupFailure) {
    throw new Error(startupFailure);
  }

  if (!READY_MARKERS.some((pattern) => pattern.test(output))) {
    throw new Error(
      "Expo preview did not reach Metro running status (expected " +
        '"Starting Metro Bundler" or "› Metro:").',
    );
  }
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not determine a free port.")),
        );
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

export function parsePreviewTimeouts(environment = process.env) {
  return {
    timeoutMs: parsePreviewTimeout(
      "PREVIEW_STARTUP_TIMEOUT_MS",
      environment.PREVIEW_STARTUP_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    handoffTimeoutMs: parsePreviewTimeout(
      "PREVIEW_HANDOFF_TIMEOUT_MS",
      environment.PREVIEW_HANDOFF_TIMEOUT_MS,
      DEFAULT_HANDOFF_TIMEOUT_MS,
    ),
    publicPreviewTimeoutMs: parsePreviewTimeout(
      "PREVIEW_PUBLIC_TIMEOUT_MS",
      environment.PREVIEW_PUBLIC_TIMEOUT_MS,
      DEFAULT_PUBLIC_PREVIEW_TIMEOUT_MS,
    ),
  };
}

function parseArgs(argv) {
  const platformIndex = argv.indexOf("--platform");
  const logFileIndex = argv.indexOf("--log-file");
  const recordLogIndex = argv.indexOf("--record-log");
  const recordOutputIndex = argv.indexOf("--record-output");
  const platform =
    platformIndex === -1 ? "android" : argv[platformIndex + 1];
  if (
    platformIndex !== -1 &&
    (!platform || platform.startsWith("--") || !HANDOFF_PLATFORM_CONFIG[platform])
  ) {
    throw new Error(
      "--platform requires either ios or android for the preview handoff preflight.",
    );
  }

  const recordOutput =
    recordOutputIndex === -1 ? null : argv[recordOutputIndex + 1];
  if (
    recordOutputIndex !== -1 &&
    (!recordOutput || recordOutput.startsWith("--"))
  ) {
    throw new Error("--record-output requires a path to a JSON output file.");
  }
  const recordLog =
    recordLogIndex === -1 ? null : argv[recordLogIndex + 1];
  if (
    recordLogIndex !== -1 &&
    (!recordLog || recordLog.startsWith("--"))
  ) {
    throw new Error("--record-log requires a path to captured startup output.");
  }
  return {
    platform,
    logFile: logFileIndex === -1 ? null : argv[logFileIndex + 1],
    recordLog,
    recordOutput,
    ...parsePreviewTimeouts(),
  };
}

async function validateCapturedLog(logFile) {
  if (!logFile) {
    throw new Error(
      "--log-file requires a path to captured Expo startup output.",
    );
  }
  const output = await readFile(resolve(logFile), "utf8");
  validatePreviewOutput(output);
  console.log(`Expo preview startup output is healthy: ${resolve(logFile)}`);
}

async function validateLivePreview(
  platform,
  timeoutMs,
  handoffTimeoutMs,
  publicPreviewTimeoutMs,
  recordLog,
  recordOutput,
) {
  const launcherOnly = process.env.PREVIEW_STARTUP_REAL_LAUNCHER === "1";
  const useStartupTestFixture = usesStartupTestFixture(process.env);
  if (!launcherOnly && !useStartupTestFixture) {
    getPublicPreviewManifestUrl(process.env);
  }
  const port = await findFreePort();
  const output = [];
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const startupCommand =
    useStartupTestFixture
      ? {
          command: process.execPath,
          args: [
            resolve(
              import.meta.dirname,
              "preview-startup-runtime-library-fixture.mjs",
            ),
          ],
        }
      : process.env.PREVIEW_STARTUP_REAL_LAUNCHER === "1"
        ? {
            command: pnpmCommand,
            args: ["exec", "expo", "start", "--localhost", "--port", String(port)],
          }
      : { command: pnpmCommand, args: ["run", "dev"] };
  const child = spawn(startupCommand.command, startupCommand.args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
    },
    detached: process.platform !== "win32",
    shell: process.platform === "win32" && startupCommand.command === pnpmCommand,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let settled = false;
  let stopRequested = false;
  let timer;
  let closeTimer;
  let failureTimer;

  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(closeTimer);
    clearTimeout(failureTimer);
    callback();
  };

  const stopChild = () => {
    if (stopRequested) return;
    stopRequested = true;
    const childPid = child.pid;
    const processGroupId = process.platform === "win32" ? undefined : childPid;
    if (child.exitCode !== null) return;
    child.once("close", () => {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    });
    if (process.platform === "win32" && childPid) {
      const processTreeKiller = spawn(
        "taskkill.exe",
        ["/PID", String(childPid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      processTreeKiller.unref();
    } else if (!processGroupId) {
      child.kill("SIGTERM");
    } else {
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    closeTimer = setTimeout(() => {
      try {
        if (process.platform === "win32") {
          if (!childPid) {
            child.kill("SIGKILL");
            return;
          }
          const processTreeKiller = spawn(
            "taskkill.exe",
            ["/PID", String(childPid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true },
          );
          processTreeKiller.unref();
        } else if (!processGroupId) {
          child.kill("SIGKILL");
        } else {
          process.kill(-processGroupId, "SIGKILL");
        }
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }, 2_000);
    closeTimer.unref();
  };

  return new Promise((resolveResult, rejectResult) => {
    const checkOutput = () => {
      const combinedOutput = output.join("");
      const startupFailure = formatStartupFailure(combinedOutput);
      if (startupFailure) {
        if (failureTimer) return true;
        failureTimer = setTimeout(() => {
          failureTimer = undefined;
          const completeFailure = formatStartupFailure(output.join(""));
          if (!completeFailure) return;
          finish(() => {
            stopChild();
            recordStartupOutput(recordLog, output.join(""));
            rejectResult(new Error(completeFailure));
          });
        }, STARTUP_FAILURE_GRACE_MS);
        return true;
      }
      return false;
    };

    const onChunk = (chunk) => {
      output.push(chunk.toString());
      checkOutput();
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.once("error", (error) => {
      finish(() => {
        stopChild();
        recordStartupOutput(recordLog, output.join(""));
        rejectResult(error);
      });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      finish(() => {
        const combinedOutput = output.join("");
        recordStartupOutput(recordLog, combinedOutput);
        const startupFailure = formatStartupFailure(combinedOutput);
        if (startupFailure) {
          rejectResult(new Error(startupFailure));
          return;
        }
        if (code !== 0) {
          rejectResult(
            new Error(
              `Expo preview exited before validation (code=${code ?? "null"}, ` +
                `signal=${signal ?? "none"}).\n${combinedOutput}`,
            ),
          );
          return;
        }
        try {
          validatePreviewOutput(combinedOutput);
          resolveResult();
        } catch (error) {
          rejectResult(error);
        }
      });
    });

    timer = setTimeout(() => {
      if (checkOutput()) return;
      const combinedOutput = output.join("");
      if (!READY_MARKERS.some((pattern) => pattern.test(combinedOutput))) {
        finish(() => {
          stopChild();
          recordStartupOutput(recordLog, combinedOutput);
          rejectResult(
            new Error(
              `Expo preview did not reach Metro running status within ${timeoutMs}ms.\n` +
                combinedOutput,
            ),
          );
        });
        return;
      }
      if (launcherOnly) {
        finish(() => {
          stopChild();
          recordStartupOutput(recordLog, combinedOutput);
          console.log(
            `Expo preview launcher reached Metro running status on port ${port}.`,
          );
          resolveResult();
        });
        return;
      }
      void (async () => {
        let publicManifest;
        let localHandoff;
        let phase = "public";
        try {
          publicManifest = await requestPublicPreviewManifest(
            publicPreviewTimeoutMs,
            process.env,
            platform,
          );
          phase = "local";
          localHandoff = await requestLocalHandoffProbe(
            port,
            handoffTimeoutMs,
            platform,
          );
          phase = "record";
          const record = createHandoffPreflightRecord({
            platform,
            publicManifest,
            localHandoff,
          });
          if (recordOutput) await writeHandoffPreflight(recordOutput, record);
          // The reachability record above is complete regardless of sign-in
          // state; the sign-in check is a separate gate for iOS Expo Go 57.
          const signIn = classifyDevServerSignIn(
            {
              localSignedIn: localHandoff.signedInDeveloper,
              publicSignedIn: publicManifest.signedInDeveloper,
            },
            process.env,
          );
          finish(() => {
            stopChild();
            recordStartupOutput(recordLog, output.join(""));
            console.log(
              `Expo preview reached Metro running status on port ${port}.`,
            );
            console.log(formatHandoffPreflight(record));
            if (signIn.severity === "pass") {
              console.log(formatDevServerSignIn(signIn));
              resolveResult();
              return;
            }
            console.warn(formatDevServerSignIn(signIn));
            if (signIn.severity === "fail") {
              rejectResult(
                new Error(
                  `Expo dev server sign-in check failed: ${signIn.evidence}`,
                ),
              );
              return;
            }
            resolveResult();
          });
        } catch (error) {
          const record = createHandoffPreflightRecord({
            platform,
            publicManifest,
            localHandoff,
            publicManifestFailed: phase === "public",
            localHandoffFailed: phase === "local",
          });
          console.log(formatHandoffPreflight(record));

          let finalError = error;
          if (recordOutput && phase !== "record") {
            try {
              await writeHandoffPreflight(recordOutput, record);
            } catch (recordError) {
              finalError = new Error(formatRecordWriteFailure(phase));
            }
          }
          finish(() => {
            stopChild();
            recordStartupOutput(recordLog, output.join(""));
            rejectResult(finalError);
          });
        }
      })();
    }, timeoutMs);
  });
}

async function main() {
  if (process.argv.includes("--validate-configuration")) {
    validatePreviewConfiguration();
    return;
  }

  if (process.argv.includes("--validate-timeouts")) {
    parsePreviewTimeouts();
    return;
  }

  const validateRecordIndex = process.argv.indexOf("--validate-record");
  if (validateRecordIndex !== -1) {
    const outputPath = process.argv[validateRecordIndex + 1];
    if (!outputPath || outputPath.startsWith("--")) {
      throw new Error("--validate-record requires a JSON file path.");
    }
    const record = await readAndValidateHandoffPreflight(outputPath);
    for (const boundary of HANDOFF_BOUNDARIES) {
      const boundaryRecord = record.boundaries[boundary];
      console.log(`${boundary}=${boundaryRecord.status}`);
      if (
        boundary === "publicManifestReachability" ||
        boundary === "localHandoffProbe"
      ) {
        console.log(`${boundary}Evidence=${boundaryRecord.evidence}`);
      }
    }
    return;
  }

  const {
    logFile,
    platform,
    timeoutMs,
    handoffTimeoutMs,
    publicPreviewTimeoutMs,
    recordLog,
    recordOutput,
  } = parseArgs(process.argv.slice(2));
  if (logFile) await validateCapturedLog(logFile);
  else
    await validateLivePreview(
      platform,
      timeoutMs,
      handoffTimeoutMs,
      publicPreviewTimeoutMs,
      recordLog,
      recordOutput,
    );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cliArgs = process.argv.slice(2);
  main().catch(async (error) => {
    if (isStartupValidationInvocation(cliArgs)) {
      await writeStartupFailureSummary(error);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
