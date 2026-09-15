import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 60_000;
const DEFAULT_PUBLIC_PREVIEW_TIMEOUT_MS = 15_000;
const STARTUP_FAILURE_GRACE_MS = 250;
const MAX_STARTUP_DIAGNOSTIC_LENGTH = 512;
const MAX_STARTUP_FAILURE_LINE_LENGTH = 320;
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
const READY_MARKERS = [/Starting Metro Bundler/i, /› Metro:/i];
const STARTUP_FAILURES = [
  /error while loading shared libraries:/i,
  /cannot open shared object file/i,
  /(?:error|failed|unable|cannot).{0,80}(?:react native )?devtools/i,
  /(?:react native )?devtools.{0,80}(?:error|failed|unable|cannot|could not|couldn't)/i,
];
const MISSING_LIBRARY = new RegExp(
  String.raw`error while loading shared libraries:\s*([A-Za-z0-9._+@/-]{1,128})\s*:\s*cannot open shared object file`,
  "i",
);

function findStartupFailure(output) {
  const lines = output.split(/\r?\n/);
  return (
    lines.find((line) =>
      STARTUP_FAILURES.some((pattern) => pattern.test(line)),
    ) ?? null
  );
}

function sanitizeStartupDiagnostic(value, maxLength) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function findMissingLibrary(output) {
  return output.match(MISSING_LIBRARY)?.[1] ?? null;
}

function formatStartupFailure(output) {
  const failure = findStartupFailure(output);
  if (!failure) return null;

  const failureDetail = sanitizeStartupDiagnostic(
    failure,
    MAX_STARTUP_FAILURE_LINE_LENGTH,
  );
  const missingLibrary = findMissingLibrary(output);
  const libraryDetail =
    missingLibrary && !failureDetail.includes(missingLibrary)
      ? ` (missing runtime library: ${missingLibrary})`
      : "";

  return `Expo preview startup error: ${sanitizeStartupDiagnostic(
    `${failureDetail}${libraryDetail}`,
    MAX_STARTUP_DIAGNOSTIC_LENGTH,
  )}`;
}

function formatRequestOutcome(stage, response, byteLength) {
  return `${stage} HTTP ${response.status} (${byteLength} bytes)`;
}

function safePreflightFailure(status) {
  return `${status} — no successful probe result was recorded`;
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

export function getPublicPreviewManifestUrl(environment = process.env) {
  const configuredUrl =
    environment.PREVIEW_PUBLIC_URL ?? environment.REPLIT_EXPO_DEV_DOMAIN;
  if (!configuredUrl) {
    throw new Error(
      "Public Expo preview manifest URL is not configured. Set " +
        "REPLIT_EXPO_DEV_DOMAIN or PREVIEW_PUBLIC_URL before running the live " +
        "preview handoff preflight.",
    );
  }

  const url = new URL(
    configuredUrl.includes("://") ? configuredUrl : `https://${configuredUrl}`,
  );
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
    response = await fetchWithDeadline(url, { headers }, deadline);
    body = await response.text();
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

  try {
    const manifest = JSON.parse(body);
    if (
      !manifest ||
      typeof manifest !== "object" ||
      typeof manifest.launchAsset?.url !== "string" ||
      manifest.launchAsset.url.length === 0
    ) {
      throw new Error("manifest did not provide a launch asset URL");
    }
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "manifest returned invalid JSON";
    throw new Error(
      `Public Expo preview manifest check failed: ${outcome}; ${detail}. ` +
        publicPreviewRecoveryMessage(),
    );
  }

  return { outcome };
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

async function fetchWithDeadline(url, options, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("request deadline exceeded");
  }

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
      const manifestResponse = await fetchWithDeadline(
        `http://127.0.0.1:${port}/`,
        { headers },
        deadline,
      );
      const manifestBody = await manifestResponse.text();
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

      const bundleResponse = await fetchWithDeadline(
        localBundleUrl(port, launchAssetUrl),
        { headers },
        deadline,
      );
      const bundleBody = await bundleResponse.arrayBuffer();
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
      };
    } catch (error) {
      lastError = new Error(
        [
          "Local Expo Go manifest/bundle probe failed:",
          outcome.manifest ?? "manifest request did not complete",
          outcome.bundle ?? "bundle request did not complete",
          error instanceof Error ? error.message : String(error),
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
    timeoutMs:
      Number(process.env.PREVIEW_STARTUP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    handoffTimeoutMs:
      Number(process.env.PREVIEW_HANDOFF_TIMEOUT_MS) ||
      DEFAULT_HANDOFF_TIMEOUT_MS,
    publicPreviewTimeoutMs:
      Number(process.env.PREVIEW_PUBLIC_TIMEOUT_MS) ||
      DEFAULT_PUBLIC_PREVIEW_TIMEOUT_MS,
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
  const port = await findFreePort();
  const output = [];
  const child = spawn("pnpm", ["run", "dev"], {
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
    if (child.exitCode === null) {
      if (process.platform === "win32" || !processGroupId) {
        child.kill("SIGTERM");
      } else {
        try {
          process.kill(-processGroupId, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
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
          finish(() => {
            stopChild();
            console.log(
              `Expo preview reached Metro running status on port ${port}.`,
            );
            console.log(formatHandoffPreflight(record));
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
              finalError = new AggregateError(
                [error, recordError],
                "Preview handoff preflight failed and its record could not be written.",
              );
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
  const validateRecordIndex = process.argv.indexOf("--validate-record");
  if (validateRecordIndex !== -1) {
    const outputPath = process.argv[validateRecordIndex + 1];
    if (!outputPath || outputPath.startsWith("--")) {
      throw new Error("--validate-record requires a JSON file path.");
    }
    const record = await readAndValidateHandoffPreflight(outputPath);
    for (const boundary of HANDOFF_BOUNDARIES) {
      console.log(
        `${boundary}=${record.boundaries[boundary].status}`,
      );
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
