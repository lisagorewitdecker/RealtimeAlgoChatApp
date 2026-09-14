import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 60_000;
const READY_MARKERS = [/Starting Metro Bundler/i, /› Metro:/i];
const STARTUP_FAILURES = [
  /error while loading shared libraries:/i,
  /cannot open shared object file/i,
  /(?:error|failed|unable|cannot).{0,80}(?:react native )?devtools/i,
  /(?:react native )?devtools.{0,80}(?:error|failed|unable|cannot)/i,
];

function findStartupFailure(output) {
  const lines = output.split(/\r?\n/);
  return (
    lines.find((line) => STARTUP_FAILURES.some((pattern) => pattern.test(line))) ??
    null
  );
}

function formatRequestOutcome(stage, response, byteLength) {
  return `${stage} HTTP ${response.status} (${byteLength} bytes)`;
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

async function requestExpoGoHandoff(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const headers = {
    "expo-platform": "ios",
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
          "Expo Go handoff failed:",
          outcome.manifest ?? "manifest request did not complete",
          outcome.bundle ?? "bundle request did not complete",
          error instanceof Error ? error.message : String(error),
        ].join(" "),
      );
      if (Date.now() >= deadline) break;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  throw lastError ?? new Error("Expo Go handoff failed before a request completed.");
}

export function validatePreviewOutput(output) {
  const failure = findStartupFailure(output);
  if (failure) {
    throw new Error(`Expo preview startup error: ${failure.trim()}`);
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
        server.close(() => reject(new Error("Could not determine a free port.")));
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
  const logFileIndex = argv.indexOf("--log-file");
  return {
    logFile: logFileIndex === -1 ? null : argv[logFileIndex + 1],
    timeoutMs: Number(process.env.PREVIEW_STARTUP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    handoffTimeoutMs:
      Number(process.env.PREVIEW_HANDOFF_TIMEOUT_MS) || DEFAULT_HANDOFF_TIMEOUT_MS,
  };
}

async function validateCapturedLog(logFile) {
  if (!logFile) {
    throw new Error("--log-file requires a path to captured Expo startup output.");
  }
  const output = await readFile(resolve(logFile), "utf8");
  validatePreviewOutput(output);
  console.log(`Expo preview startup output is healthy: ${resolve(logFile)}`);
}

async function validateLivePreview(timeoutMs, handoffTimeoutMs) {
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

  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(closeTimer);
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
      const failure = findStartupFailure(combinedOutput);
      if (failure) {
        finish(() => {
          stopChild();
          rejectResult(new Error(`Expo preview startup error: ${failure.trim()}`));
        });
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
        try {
          const handoff = await requestExpoGoHandoff(port, handoffTimeoutMs);
          finish(() => {
            stopChild();
            console.log(`Expo preview reached Metro running status on port ${port}.`);
            console.log(
              `Expo Go handoff succeeded: ${handoff.manifest}; ${handoff.bundle}; ` +
                `path=${handoff.launchAssetPath}`,
            );
            resolveResult();
          });
        } catch (error) {
          finish(() => {
            stopChild();
            rejectResult(error);
          });
        }
      })();
    }, timeoutMs);
  });
}

async function main() {
  const { logFile, timeoutMs, handoffTimeoutMs } = parseArgs(process.argv.slice(2));
  if (logFile) await validateCapturedLog(logFile);
  else await validateLivePreview(timeoutMs, handoffTimeoutMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}