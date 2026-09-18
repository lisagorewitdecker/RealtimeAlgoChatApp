import { createServer } from "node:net";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { findDuplicateJsonObjectKeys } from "../../../scripts/find-duplicate-json-object-keys.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 60_000;
const DEFAULT_PUBLIC_PREVIEW_TIMEOUT_MS = 15_000;
// Five minutes is long enough for a cold CI preview while preventing a
// misconfigured job from waiting indefinitely.
export const MAX_PREVIEW_TIMEOUT_MS = 5 * 60_000;
const STARTUP_FAILURE_GRACE_MS = 250;
const MAX_STARTUP_DIAGNOSTIC_LENGTH = 512;
const MAX_STARTUP_FAILURE_LINE_LENGTH = 320;
const MAX_STARTUP_SUMMARY_LENGTH = 512;
const MAX_STARTUP_LIBRARY_DETAIL_LENGTH = 192;
const STARTUP_DIAGNOSTIC_PREFIX = "Expo preview startup error: ";
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
const READY_MARKERS = [/Starting Metro Bundler/i, /› Metro:/i];
const STARTUP_FAILURES = [
  /error while loading shared libraries:/i,
  /cannot open shared object file/i,
  /library not loaded:/i,
  /cannot proceed because [^\r\n]+ was not found/i,
  /(?:error|failed|unable|cannot).{0,80}(?:react native )?devtools/i,
  /(?:react native )?devtools.{0,80}(?:error|failed|unable|cannot|could not|couldn't)/i,
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
]);
const MISSING_LIBRARY_PATH = String.raw`[A-Za-z0-9._+~ /\\:-]`;
const MISSING_LIBRARY_CAPTURE = String.raw`(?:(["'])([^"'\u0000-\u001f\u007f]+)\1|(${MISSING_LIBRARY_PATH}+?))`;
const MISSING_LIBRARY_DYLD_CAPTURE = String.raw`(?:(["'])([^"'\u0000-\u001f\u007f]+)\1|(${MISSING_LIBRARY_PATH}+))`;
const MISSING_LIBRARY_PATTERNS = [
  new RegExp(
    String.raw`error while loading shared libraries:\s*${MISSING_LIBRARY_CAPTURE}\s*:\s*cannot open shared object file`,
    "i",
  ),
  new RegExp(
    String.raw`library not loaded:\s*${MISSING_LIBRARY_DYLD_CAPTURE}`,
    "i",
  ),
  new RegExp(
    String.raw`cannot proceed because\s+${MISSING_LIBRARY_CAPTURE}\s+was not found`,
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

function findMissingLibrary(output) {
  for (const line of output.split(/\r?\n/)) {
    for (const pattern of MISSING_LIBRARY_PATTERNS) {
      const match = line.match(pattern);
      const missingLibrary = (match?.[2] ?? match?.[3])?.trim();
      if (missingLibrary) return missingLibrary;
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
  if (failure) {
    const fullFailureDetail = sanitizeStartupDiagnostic(
      failure,
      MAX_STARTUP_FAILURE_LINE_LENGTH,
    );
    const missingLibrary = findMissingLibrary(output);
    const libraryDetail =
      missingLibrary &&
      (!fullFailureDetail.includes(missingLibrary) ||
        missingLibrary.length > MAX_STARTUP_LIBRARY_DETAIL_LENGTH)
        ? ` (missing runtime library: ${compactStartupLibraryPath(missingLibrary)})`
        : "";

    const failureLength = Math.min(
      fullFailureDetail.length,
      Math.max(
        0,
        MAX_STARTUP_DIAGNOSTIC_LENGTH -
          STARTUP_DIAGNOSTIC_PREFIX.length -
          libraryDetail.length,
      ),
    );
    const failureDetail = fullFailureDetail.slice(0, failureLength);

    return `${STARTUP_DIAGNOSTIC_PREFIX}${sanitizeStartupDiagnostic(
      `${failureDetail}${libraryDetail}`,
      MAX_STARTUP_DIAGNOSTIC_LENGTH - STARTUP_DIAGNOSTIC_PREFIX.length,
    )}`;
  }

  const unrecognizedLoaderFailure = findUnrecognizedLoaderFailure(output);
  if (!unrecognizedLoaderFailure) return null;

  return `${STARTUP_DIAGNOSTIC_PREFIX}${sanitizeStartupDiagnostic(
    `${LOADER_COMPATIBILITY_MAINTENANCE_MESSAGE} Observed: ${sanitizeStartupDiagnostic(
      unrecognizedLoaderFailure,
      MAX_STARTUP_FAILURE_LINE_LENGTH,
    )}`,
    MAX_STARTUP_DIAGNOSTIC_LENGTH - STARTUP_DIAGNOSTIC_PREFIX.length,
  )}`;
}

function sanitizeStartupSummaryDiagnostic(value) {
  return sanitizeStartupDiagnostic(value, MAX_STARTUP_SUMMARY_LENGTH)
    .replace(/https?:\/\/\S+/gi, "[redacted URL]")
    .replace(
      /\b(?:authorization|proxy-authorization)\s*:?.*$/gi,
      "[redacted authorization]",
    )
    .replace(
      /\b(?:api[_-]?key|credential|password|passwd|secret|token)\s*(?:[=:]\s*|\s+)\S+/gi,
      "[redacted credential]",
    )
    .replace(/[`*]/g, "")
    .slice(0, MAX_STARTUP_SUMMARY_LENGTH);
}

function formatStartupFailureSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
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
    source = await readFile(resolve(outputPath), "utf8");
  } catch {
    throw new Error("Preview handoff preflight JSON could not be read.");
  }

  if (findDuplicateJsonObjectKeys(source).length > 0) {
    throw new Error("Preview handoff preflight JSON contains duplicate fields.");
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
      if (Date.now() >= deadline) break;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
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

export function parsePreviewTimeout(name, value, defaultValue) {
  if (value == null) return defaultValue;

  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `${name} must be a positive finite number of milliseconds.`,
    );
  }
  if (timeoutMs > MAX_PREVIEW_TIMEOUT_MS) {
    throw new Error(
      `${name} must be between 1 and ${MAX_PREVIEW_TIMEOUT_MS} milliseconds.`,
    );
  }

  return timeoutMs;
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
  return {
    platform,
    logFile: logFileIndex === -1 ? null : argv[logFileIndex + 1],
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
  recordOutput,
) {
  getPublicPreviewManifestUrl(process.env);
  const port = await findFreePort();
  const output = [];
  const startupCommand =
    STARTUP_TEST_FIXTURES.has(process.env.PREVIEW_STARTUP_TEST_FIXTURE)
      ? {
          command: process.execPath,
          args: [
            resolve(
              import.meta.dirname,
              "preview-startup-runtime-library-fixture.mjs",
            ),
          ],
        }
      : { command: "pnpm", args: ["run", "dev"] };
  const child = spawn(startupCommand.command, startupCommand.args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
    },
    detached: process.platform !== "win32",
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
    const processGroupId = child.pid;
    if (child.exitCode !== null) return;
    child.once("close", () => {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    });
    if (process.platform === "win32" || !processGroupId) {
      child.kill("SIGTERM");
    } else {
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    closeTimer = setTimeout(() => {
      if (!processGroupId) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-processGroupId, "SIGKILL");
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
        rejectResult(error);
      });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      finish(() => {
        const combinedOutput = output.join("");
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
          rejectResult(
            new Error(
              `Expo preview did not reach Metro running status within ${timeoutMs}ms.\n` +
                combinedOutput,
            ),
          );
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
            rejectResult(finalError);
          });
        }
      })();
    }, timeoutMs);
  });
}

async function main() {
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
    recordOutput,
  } = parseArgs(process.argv.slice(2));
  if (logFile) await validateCapturedLog(logFile);
  else
    await validateLivePreview(
      platform,
      timeoutMs,
      handoffTimeoutMs,
      publicPreviewTimeoutMs,
      recordOutput,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliArgs = process.argv.slice(2);
  main().catch(async (error) => {
    if (isStartupValidationInvocation(cliArgs)) {
      await writeStartupFailureSummary(error);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
