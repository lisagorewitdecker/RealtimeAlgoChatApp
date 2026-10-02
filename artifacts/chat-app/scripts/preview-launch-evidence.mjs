// Launch-evidence probe for the Chat App development preview.
//
// The preview-startup preflight proves that Metro serves the manifest and the
// bundle and that the dev server is signed in, but it cannot tell whether Expo
// Go actually ran the bundle: on Replit's iPhone simulator Expo Go can download
// the bundle and quit ~4 s later while every preflight check passes. Because
// the simulator's Expo Go re-fetches the bundle after every Metro restart, one
// instrumented restart is enough evidence and nobody has to touch the device.
//
// The `dev` script always starts Expo through `--launch`. Unarmed, that is a
// transparent pass-through. `--arm` writes a one-shot marker; the next managed
// restart consumes it, enables the redacted Metro request log
// (EXPO_DEV_REQUEST_LOG=1) and DEBUG=Metro:InspectorProxy for that run only,
// mirrors the dev server output unchanged into the workflow log, and classifies
// what Expo Go did:
//
//   NO_DEVICE               no Expo Go iOS (app=host.exp.Exponent) inspector
//                           connection within the device budget
//   BUNDLE_ONLY_THEN_CLOSED bundle HTTP 200, then an abnormal inspector close
//                           with no iOS client log or asset request — the app
//                           quit during startup
//   RUNNING                 the connection stayed open through the settle
//                           budget and an iOS client log or asset request
//                           followed the bundle
//   INCONCLUSIVE            anything else; the reason says what was missing
//
// Everything this script prints or stores is derived from constants and
// counts: never a device name or id, host, URL, account, or session value.
// The dev script's `Logged in as …` sign-in line runs before the launcher and
// is never read or echoed by it.
//
// Every managed start (armed or not) also records its start time in
// `.expo/preview-dev-server-start.json`. The preview-startup preflight copies
// the latest result into the handoff record's `expoGoLaunch` boundary and
// compares `decidedAt` with that start so a result from an earlier dev server
// is reported as STALE. The preflight's own throwaway dev server sets
// PREVIEW_LAUNCH_PROBE_PASSTHROUGH=1, which makes `--launch` a pure
// pass-through: no marker is consumed and no start or result is written.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findDuplicateJsonObjectKeys } from "../../../scripts/find-duplicate-json-object-keys.mjs";
import { parsePreviewTimeout, READY_MARKERS } from "./preview-startup-shared.mjs";

export const LAUNCH_EVIDENCE_STATUSES = Object.freeze({
  noDevice: "NO_DEVICE",
  bundleOnlyThenClosed: "BUNDLE_ONLY_THEN_CLOSED",
  running: "RUNNING",
  inconclusive: "INCONCLUSIVE",
});
export const EXPO_GO_IOS_APP_ID = "host.exp.Exponent";
export const INSPECTOR_DEBUG_NAMESPACE = "Metro:InspectorProxy";
export const PROBE_MARKER_FILENAME = "preview-launch-probe.armed";
export const PROBE_RESULT_FILENAME = "preview-launch-evidence.json";
export const DEV_SERVER_START_FILENAME = "preview-dev-server-start.json";
export const PROBE_MARKER_SCHEMA = "ios-preview-launch-probe-marker/v1";
export const PROBE_RESULT_SCHEMA = "ios-preview-launch-evidence/v1";
export const DEV_SERVER_START_SCHEMA = "preview-dev-server-start/v1";
export const PROBE_PASSTHROUGH_ENVIRONMENT_NAME =
  "PREVIEW_LAUNCH_PROBE_PASSTHROUGH";
// The probe writes `new Date().toISOString()`; anything else is corruption.
const PROBE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const DEFAULT_DEVICE_TIMEOUT_MS = 90_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;
const PROBE_LOG_PREFIX = "[preview-launch-probe]";
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_STATE_DIRECTORY = resolve(PACKAGE_ROOT, ".expo");
const EVALUATION_INTERVAL_MS = 250;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const ANSI_ESCAPE = String.fromCharCode(27);
// RFC 6455: 1000 = normal closure, 1001 = going away (reload/app backgrounded
// by choice). Everything else, including 1006 (no close frame), is abnormal.
const NORMAL_CLOSE_CODES = new Set([1000, 1001]);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ISO_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const LEADING_TIMESTAMP_PATTERN = new RegExp(`^\\s*(${ISO_TIMESTAMP}) `);
// @react-native/dev-middleware InspectorProxy debug lines. The device name and
// id are matched permissively and never captured.
const DEVICE_CONNECTION_PATTERN =
  /Got new device connection: name='.*', app=([^,\s]+), device=/;
const DEVICE_CLOSE_PATTERN =
  /Connection closed to device='.*' for app='([^']*)' with code='(\d+)'/;
// Redacted request log written by metro.config.js when EXPO_DEV_REQUEST_LOG=1.
const DEV_REQUEST_PATTERN = new RegExp(
  String.raw`\[dev-request\] (${ISO_TIMESTAMP}) (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\d{3}) (\d+)ms platform=(ios|android|web|-) client=(preview-validation|Expo Go|curl|browser|other) user-agent=\[redacted\] resource=(manifest|bundle|asset|other)(?=\s|$)`,
);
// Expo CLI forwards device console output as "<Platform>  <LEVEL>  message".
const IOS_CLIENT_LOG_PATTERN =
  /^\s*iOS\s{1,2}(LOG|INFO|WARN|ERROR|DEBUG|TRACE|GROUP|TABLE|DIR|ASSERT)\s/;
const ERROR_CLIENT_LOG_LEVELS = new Set(["ERROR"]);

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

function parseIsoMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function leadingTimestampMs(line) {
  const match = LEADING_TIMESTAMP_PATTERN.exec(line);
  return match ? parseIsoMs(match[1]) : null;
}

function formatSeconds(ms) {
  return `${Math.round(ms / 100) / 10}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function mergeDebugNamespaces(existing, namespace) {
  const namespaces = String(existing ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!namespaces.includes(namespace)) namespaces.push(namespace);
  return namespaces.join(",");
}

export function createLaunchEvidenceClassifier(options = {}) {
  const deviceTimeoutMs = options.deviceTimeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  // The armed launcher sets EXPO_DEV_REQUEST_LOG itself; a captured log gives
  // no such guarantee, so only then is a missing request log worth a hint.
  const requestLogEnabled = options.requestLogEnabled === true;
  const state = {
    startedAt: options.startedAt ?? null,
    lines: 0,
    metroReady: false,
    metroReadyAt: null,
    requestLines: 0,
    connections: 0,
    otherConnections: 0,
    pendingBundle: null,
    session: null,
  };

  function openSession() {
    return state.session && !state.session.close ? state.session : null;
  }

  function observe(rawLine, atMs = null) {
    const line = stripAnsi(String(rawLine)).trimEnd();
    state.lines += 1;
    if (!line) return;
    const lineMs = leadingTimestampMs(line);

    if (!state.metroReady && READY_MARKERS.some((pattern) => pattern.test(line))) {
      state.metroReady = true;
      state.metroReadyAt = atMs;
    }

    const connection = DEVICE_CONNECTION_PATTERN.exec(line);
    if (connection) {
      if (connection[1] !== EXPO_GO_IOS_APP_ID) {
        state.otherConnections += 1;
        return;
      }
      state.connections += 1;
      state.session = {
        connectedAt: atMs,
        bundle: state.pendingBundle,
        bundleCount: state.pendingBundle ? 1 : 0,
        // Only output logged after this session's bundle HTTP 200 proves that
        // bundle ran; anything earlier came from a previous bundle execution.
        appEvidence: [],
        errorLogs: 0,
        linesBeforeBundle: 0,
        close: null,
      };
      state.pendingBundle = null;
      return;
    }

    const close = DEVICE_CLOSE_PATTERN.exec(line);
    if (close) {
      const session = openSession();
      if (close[1] === EXPO_GO_IOS_APP_ID && session) {
        session.close = {
          code: Number(close[2]),
          atMs,
          lineMs,
          evidenceBefore: session.appEvidence.length,
          errorLogsBefore: session.errorLogs,
        };
      }
      return;
    }

    const request = DEV_REQUEST_PATTERN.exec(line);
    if (request) {
      state.requestLines += 1;
      const [, isoTimestamp, , status, , platform, client, resource] = request;
      const session = openSession();
      if (
        resource === "bundle" &&
        platform === "ios" &&
        client === "Expo Go" &&
        status === "200"
      ) {
        const bundle = { atMs, lineMs: parseIsoMs(isoTimestamp) };
        if (session) {
          session.bundle ??= bundle;
          session.bundleCount += 1;
        } else {
          state.pendingBundle = bundle;
        }
        return;
      }
      if (
        resource === "asset" &&
        (client === "Expo Go" || client === "other") &&
        (platform === "ios" || platform === "-") &&
        session
      ) {
        if (!session.bundle) {
          session.linesBeforeBundle += 1;
          return;
        }
        session.appEvidence.push({ kind: "asset-request", atMs });
      }
      return;
    }

    const clientLog = IOS_CLIENT_LOG_PATTERN.exec(line);
    if (clientLog) {
      const session = openSession();
      if (!session) return;
      if (!session.bundle) {
        session.linesBeforeBundle += 1;
        return;
      }
      if (ERROR_CLIENT_LOG_LEVELS.has(clientLog[1])) session.errorLogs += 1;
      else session.appEvidence.push({ kind: "client-log", atMs });
    }
  }

  function elapsedBetween(from, to) {
    if (from?.atMs != null && to?.atMs != null) return to.atMs - from.atMs;
    if (from?.lineMs != null && to?.lineMs != null) return to.lineMs - from.lineMs;
    return null;
  }

  function observation() {
    const session = state.session;
    const bundleToClose =
      session?.close && session.bundle
        ? elapsedBetween(session.bundle, session.close)
        : null;
    return {
      metroReady: state.metroReady,
      requestLogLines: state.requestLines,
      expoGoIosConnections: state.connections,
      otherInspectorConnections: state.otherConnections,
      iosBundleHttp200: session?.bundleCount ?? 0,
      inspectorCloseCode: session?.close ? session.close.code : null,
      bundleToCloseSeconds:
        bundleToClose == null ? null : Math.round(bundleToClose / 100) / 10,
      iosClientLogLines:
        session?.appEvidence.filter((item) => item.kind === "client-log").length ??
        0,
      iosClientErrorLines: session?.errorLogs ?? 0,
      expoGoAssetRequests:
        session?.appEvidence.filter((item) => item.kind === "asset-request")
          .length ?? 0,
      iosLinesBeforeBundle: session?.linesBeforeBundle ?? 0,
      deviceTimeoutMs,
      settleTimeoutMs,
    };
  }

  function beforeBundleNote(session) {
    return session.linesBeforeBundle > 0
      ? ` ${plural(session.linesBeforeBundle, "iOS client log or asset line")} logged before this bundle came from an earlier bundle and did not count.`
      : "";
  }

  function requestLogHint() {
    return state.requestLines === 0 && !requestLogEnabled
      ? " No redacted request-log lines were seen; confirm EXPO_DEV_REQUEST_LOG=1 was active for this run."
      : "";
  }

  function decided(status, reason) {
    return {
      decided: true,
      status,
      passed: status === LAUNCH_EVIDENCE_STATUSES.running,
      reason,
      observation: observation(),
    };
  }

  function evaluate(
    nowMs = null,
    { final = false, finalLabel = "in the captured output" } = {},
  ) {
    const session = state.session;
    const { noDevice, bundleOnlyThenClosed, running, inconclusive } =
      LAUNCH_EVIDENCE_STATUSES;

    if (!session) {
      const windowStart = state.metroReadyAt ?? state.startedAt;
      const budgetElapsed =
        nowMs != null && windowStart != null && nowMs - windowStart >= deviceTimeoutMs;
      if (!final && !budgetElapsed) return { decided: false, observation: observation() };
      const others =
        state.otherConnections > 0
          ? ` ${plural(state.otherConnections, "other inspector connection")} appeared (not Expo Go iOS).`
          : "";
      const metro = state.metroReady
        ? ""
        : " Metro never reported that it was running.";
      return decided(
        noDevice,
        `No Expo Go iOS device (app=${EXPO_GO_IOS_APP_ID}) connected to the Metro inspector ` +
          (final && !budgetElapsed
            ? `${finalLabel}.`
            : `within ${formatSeconds(deviceTimeoutMs)} s of Metro startup.`) +
          metro +
          others +
          requestLogHint(),
      );
    }

    if (session.close) {
      const { code, evidenceBefore } = session.close;
      const bundleToClose = session.bundle
        ? elapsedBetween(session.bundle, session.close)
        : null;
      const gap =
        bundleToClose == null ? "" : ` ${formatSeconds(bundleToClose)} s after the bundle`;
      if (NORMAL_CLOSE_CODES.has(code)) {
        return decided(
          inconclusive,
          `The Expo Go iOS inspector connection closed normally (code ${code})${gap}; that is a reload or a deliberate exit, not startup evidence.`,
        );
      }
      if (!session.bundle) {
        const windowStart = state.metroReadyAt ?? state.startedAt;
        const deviceBudgetElapsed =
          nowMs != null &&
          windowStart != null &&
          nowMs - windowStart >= deviceTimeoutMs;
        // Expo Go can briefly connect and close its inspector while reloading,
        // then establish the real app session and request the bundle a few
        // seconds later. Keep the live probe open for that replacement session
        // instead of finalizing on the transient pre-bundle connection.
        if (!final && !deviceBudgetElapsed) {
          return { decided: false, observation: observation() };
        }
        return decided(
          inconclusive,
          `The Expo Go iOS inspector connection closed abnormally (code ${code}) before any iOS Expo Go bundle HTTP 200 was logged.` +
            requestLogHint(),
        );
      }
      if (evidenceBefore === 0) {
        return decided(
          bundleOnlyThenClosed,
          `Expo Go iOS downloaded the bundle (HTTP 200) and the inspector connection closed abnormally (code ${code})${gap} with no iOS client log or asset request: the app quit during startup.` +
            beforeBundleNote(session),
        );
      }
      return decided(
        inconclusive,
        `The Expo Go iOS inspector connection closed abnormally (code ${code})${gap} after ${plural(evidenceBefore, "app evidence line")}: the app started and then stopped; inspect the workflow log.`,
      );
    }

    const anchor = session.bundle ?? { atMs: session.connectedAt };
    const settled =
      nowMs != null && anchor.atMs != null && nowMs - anchor.atMs >= settleTimeoutMs;
    if (!final && !settled) return { decided: false, observation: observation() };
    const windowLabel = settled
      ? `within ${formatSeconds(settleTimeoutMs)} s of the bundle`
      : finalLabel;
    if (!session.bundle) {
      return decided(
        inconclusive,
        `Expo Go iOS connected to the inspector but no iOS Expo Go bundle HTTP 200 was logged ${windowLabel}.` +
          requestLogHint(),
      );
    }
    if (session.errorLogs > 0) {
      return decided(
        inconclusive,
        `The Expo Go iOS connection stayed open but ${plural(session.errorLogs, "error-level iOS client log line")} followed the bundle; inspect the workflow log before treating the launch as healthy.`,
      );
    }
    if (session.appEvidence.length === 0) {
      return decided(
        inconclusive,
        `Expo Go iOS downloaded the bundle and the inspector connection stayed open, but no iOS client log or asset request followed ${windowLabel}; the app cannot be confirmed as running.` +
          beforeBundleNote(session),
      );
    }
    const logs = session.appEvidence.filter((item) => item.kind === "client-log").length;
    const assets = session.appEvidence.length - logs;
    return decided(
      running,
      `Expo Go iOS downloaded the bundle, the inspector connection stayed open ${windowLabel}, and ${plural(logs, "iOS client log line")} and ${plural(assets, "asset request")} followed.`,
    );
  }

  return { observe, evaluate };
}

export function splitLogLines(text) {
  return String(text).split(/\r\n|\n|\r/);
}

export function classifyLaunchEvidence(text, options = {}) {
  const classifier = createLaunchEvidenceClassifier(options);
  for (const line of splitLogLines(text)) classifier.observe(line);
  return classifier.evaluate(null, { final: true });
}

export function formatLaunchEvidenceSummary(result) {
  const o = result.observation;
  const yesNo = (value) => (value ? "yes" : "no");
  const lines = [
    `preview_launch_evidence=${result.status}`,
    `metro_ready=${yesNo(o.metroReady)}`,
    `expo_go_ios_connections=${o.expoGoIosConnections}`,
    `other_inspector_connections=${o.otherInspectorConnections}`,
    `ios_bundle_http_200=${o.iosBundleHttp200}`,
    `inspector_close_code=${o.inspectorCloseCode ?? "none"}`,
    `bundle_to_close_seconds=${
      o.inspectorCloseCode == null
        ? "n/a"
        : o.bundleToCloseSeconds == null
          ? "unknown"
          : o.bundleToCloseSeconds
    }`,
    `ios_client_log_lines=${o.iosClientLogLines}`,
    `ios_client_error_lines=${o.iosClientErrorLines}`,
    `expo_go_asset_requests=${o.expoGoAssetRequests}`,
    `ios_lines_before_bundle=${o.iosLinesBeforeBundle}`,
    `request_log_lines=${o.requestLogLines}`,
  ];
  if (result.devServerExit) lines.push(`dev_server_exit=${result.devServerExit}`);
  lines.push(`reason=${result.reason}`);
  return lines;
}

export function parseLaunchProbeTimeouts(environment = process.env) {
  return {
    deviceTimeoutMs: parsePreviewTimeout(
      "PREVIEW_LAUNCH_DEVICE_TIMEOUT_MS",
      environment.PREVIEW_LAUNCH_DEVICE_TIMEOUT_MS,
      DEFAULT_DEVICE_TIMEOUT_MS,
    ),
    settleTimeoutMs: parsePreviewTimeout(
      "PREVIEW_LAUNCH_SETTLE_TIMEOUT_MS",
      environment.PREVIEW_LAUNCH_SETTLE_TIMEOUT_MS,
      DEFAULT_SETTLE_TIMEOUT_MS,
    ),
  };
}

function probePaths(stateDirectory) {
  const directory = resolve(stateDirectory ?? DEFAULT_STATE_DIRECTORY);
  return {
    directory,
    marker: resolve(directory, PROBE_MARKER_FILENAME),
    result: resolve(directory, PROBE_RESULT_FILENAME),
    start: resolve(directory, DEV_SERVER_START_FILENAME),
  };
}

// Returns the epoch milliseconds of a probe-written timestamp, or null when
// the value is not the exact ISO-8601 UTC form the probe writes.
export function parseProbeTimestamp(value) {
  if (typeof value !== "string" || !PROBE_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function armLaunchProbe({ stateDirectory, environment = process.env } = {}) {
  const timeouts = parseLaunchProbeTimeouts(environment);
  const paths = probePaths(stateDirectory);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.marker,
    `${JSON.stringify(
      {
        schema: PROBE_MARKER_SCHEMA,
        armedAt: new Date().toISOString(),
        ...timeouts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rm(paths.result, { force: true });
  return { ...paths, ...timeouts };
}

export async function disarmLaunchProbe({ stateDirectory } = {}) {
  const paths = probePaths(stateDirectory);
  await rm(paths.marker, { force: true });
  return paths;
}

// The marker and result files are the probe's own records, but they are read
// back as release evidence: reject duplicate fields before JSON.parse applies
// last-value-wins semantics, and never echo the file contents.
function parseProbeRecord(contents, fileName) {
  if (findDuplicateJsonObjectKeys(contents).length > 0) {
    throw new Error(
      `Launch-evidence probe JSON contains duplicate fields (${fileName}).`,
    );
  }
  try {
    return JSON.parse(contents);
  } catch {
    // JSON.parse quotes a fragment of the source in its message.
    throw new Error(`Launch-evidence probe JSON is not valid JSON (${fileName}).`);
  }
}

async function consumeMarker(paths) {
  let contents;
  try {
    contents = await readFile(paths.marker, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  // One managed restart: the marker is gone before the dev server starts.
  await rm(paths.marker, { force: true });
  let marker;
  try {
    marker = parseProbeRecord(contents, PROBE_MARKER_FILENAME);
  } catch (error) {
    throw new Error(
      `${PROBE_MARKER_FILENAME} is not valid JSON (${error.message}); run --arm again to rewrite it.`,
    );
  }
  if (marker?.schema !== PROBE_MARKER_SCHEMA) {
    throw new Error(
      `${PROBE_MARKER_FILENAME} has an unexpected schema; run --arm again to rewrite it.`,
    );
  }
  return {
    deviceTimeoutMs: parsePreviewTimeout(
      "deviceTimeoutMs",
      marker.deviceTimeoutMs,
      DEFAULT_DEVICE_TIMEOUT_MS,
    ),
    settleTimeoutMs: parsePreviewTimeout(
      "settleTimeoutMs",
      marker.settleTimeoutMs,
      DEFAULT_SETTLE_TIMEOUT_MS,
    ),
  };
}

// Resolves to null when no result has been written; malformed results throw
// without echoing their contents.
export async function findLaunchProbeResult({ stateDirectory } = {}) {
  const paths = probePaths(stateDirectory);
  let contents;
  try {
    contents = await readFile(paths.result, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const result = parseProbeRecord(contents, PROBE_RESULT_FILENAME);
  if (result?.schema !== PROBE_RESULT_SCHEMA) {
    throw new Error(`Unexpected launch-evidence result schema in ${paths.result}.`);
  }
  if (!Object.values(LAUNCH_EVIDENCE_STATUSES).includes(result.status)) {
    throw new Error(`Unexpected launch-evidence status in ${paths.result}.`);
  }
  return result;
}

export async function readLaunchProbeResult({ stateDirectory } = {}) {
  const result = await findLaunchProbeResult({ stateDirectory });
  if (!result) {
    const paths = probePaths(stateDirectory);
    throw new Error(
      `No launch-evidence result at ${paths.result}. Arm the probe with --arm, restart the artifacts/chat-app: expo workflow once, and wait for the classification.`,
    );
  }
  return result;
}

// The start record of the latest managed dev server start (null when none has
// been recorded). Its only purpose is the STALE comparison in the preflight.
export async function readDevServerStart({ stateDirectory } = {}) {
  const paths = probePaths(stateDirectory);
  let contents;
  try {
    contents = await readFile(paths.start, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = parseProbeRecord(contents, DEV_SERVER_START_FILENAME);
  if (record?.schema !== DEV_SERVER_START_SCHEMA) {
    throw new Error(`Unexpected dev server start schema in ${paths.start}.`);
  }
  const startedAtMs = parseProbeTimestamp(record.startedAt);
  if (startedAtMs === null) {
    throw new Error(`Invalid dev server start timestamp in ${paths.start}.`);
  }
  return { startedAt: new Date(startedAtMs).toISOString(), startedAtMs };
}

async function recordDevServerStart(paths, log) {
  try {
    await mkdir(paths.directory, { recursive: true });
    await writeFile(
      paths.start,
      `${JSON.stringify(
        { schema: DEV_SERVER_START_SCHEMA, startedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    log(
      `${PROBE_LOG_PREFIX} could not record the dev server start (${error.code ?? "unknown error"}); ` +
        "the preview preflight reports launch evidence as STALE until a start is recorded.",
    );
  }
}

function createLineFeeder(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  return {
    push(chunk) {
      buffered += decoder.write(chunk);
      const parts = buffered.split(/\r\n|\n|\r/);
      buffered = parts.pop();
      for (const part of parts) onLine(part);
    },
    end() {
      buffered += decoder.end();
      if (buffered) onLine(buffered);
      buffered = "";
    },
  };
}

function describeExit(code, signal) {
  return signal ? `signal:${signal}` : `code:${code}`;
}

function forwardSignals(child) {
  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill(signal);
        } catch {
          // The child is already gone; its exit handler finishes the launcher.
        }
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function exitLikeChild(code, signal) {
  if (signal) {
    process.kill(process.pid, signal);
    // If the signal is ignored or blocked, still end with a conventional code.
    setTimeout(() => process.exit(1), 100).unref();
    return;
  }
  process.exitCode = code ?? 1;
}

export async function launchDevServer({
  command,
  args = [],
  stateDirectory,
  environment = process.env,
  cwd = PACKAGE_ROOT,
  log = (line) => process.stdout.write(`${line}\n`),
  onExit = exitLikeChild,
} = {}) {
  if (!command) {
    throw new Error("--launch requires the dev server command after `--`.");
  }
  const paths = probePaths(stateDirectory);
  // The preview preflight starts its own throwaway dev server through the
  // same dev script; it must neither consume an armed marker meant for the
  // managed workflow nor overwrite the managed start and result records.
  const passThrough =
    environment[PROBE_PASSTHROUGH_ENVIRONMENT_NAME] === "1";
  const armed = passThrough ? null : await consumeMarker(paths);
  if (passThrough) {
    log(
      `${PROBE_LOG_PREFIX} ${PROBE_PASSTHROUGH_ENVIRONMENT_NAME}=1: pass-through start; ` +
        "no armed marker is consumed and no start or launch-evidence record is written.",
    );
  } else {
    await recordDevServerStart(paths, log);
  }

  if (!armed) {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    const restoreSignals = forwardSignals(child);
    child.once("error", (error) => {
      restoreSignals();
      log(`${PROBE_LOG_PREFIX} could not start the dev server: ${error.message}`);
      onExit(1, null);
    });
    child.once("exit", (code, signal) => {
      restoreSignals();
      onExit(code, signal);
    });
    return { armed: false, passThrough, child };
  }

  const startedAt = Date.now();
  const classifier = createLaunchEvidenceClassifier({
    ...armed,
    startedAt,
    requestLogEnabled: true,
  });
  log(
    `${PROBE_LOG_PREFIX} armed: this restart runs with EXPO_DEV_REQUEST_LOG=1 and DEBUG=${INSPECTOR_DEBUG_NAMESPACE}; ` +
      `waiting up to ${formatSeconds(armed.deviceTimeoutMs)} s for Expo Go iOS and ${formatSeconds(armed.settleTimeoutMs)} s for it to settle.`,
  );
  const child = spawn(command, args, {
    cwd,
    env: {
      ...environment,
      EXPO_DEV_REQUEST_LOG: "1",
      DEBUG: mergeDebugNamespaces(environment.DEBUG, INSPECTOR_DEBUG_NAMESPACE),
    },
    stdio: ["inherit", "pipe", "pipe"],
  });
  const restoreSignals = forwardSignals(child);

  let result = null;
  let pendingWrite = Promise.resolve();
  const settle = (evaluation, devServerExit) => {
    if (result) return;
    result = {
      schema: PROBE_RESULT_SCHEMA,
      decidedAt: new Date().toISOString(),
      mode: "live",
      status: evaluation.status,
      passed: evaluation.passed,
      reason: evaluation.reason,
      observation: evaluation.observation,
      ...(devServerExit ? { devServerExit } : {}),
    };
    for (const line of formatLaunchEvidenceSummary(result)) log(`${PROBE_LOG_PREFIX} ${line}`);
    log(`${PROBE_LOG_PREFIX} result written to ${paths.result}`);
    pendingWrite = mkdir(paths.directory, { recursive: true })
      .then(() => writeFile(paths.result, `${JSON.stringify(result, null, 2)}\n`, "utf8"))
      .catch((error) => {
        log(`${PROBE_LOG_PREFIX} could not write the result file (${error.code ?? "unknown error"}).`);
      });
  };
  const evaluateNow = (options) => {
    if (result) return;
    const evaluation = classifier.evaluate(Date.now(), options);
    if (evaluation.decided) settle(evaluation, options?.devServerExit);
  };
  const feed = (line) => {
    classifier.observe(line, Date.now());
    evaluateNow();
  };
  const stdoutFeeder = createLineFeeder(feed);
  const stderrFeeder = createLineFeeder(feed);
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdoutFeeder.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrFeeder.push(chunk);
  });
  child.stdout.once("end", () => stdoutFeeder.end());
  child.stderr.once("end", () => stderrFeeder.end());
  const timer = setInterval(() => evaluateNow(), EVALUATION_INTERVAL_MS);

  let spawnFailed = false;
  child.once("error", (error) => {
    spawnFailed = true;
    clearInterval(timer);
    restoreSignals();
    log(`${PROBE_LOG_PREFIX} could not start the dev server: ${error.message}`);
    onExit(1, null);
  });
  child.once("close", (code, signal) => {
    if (spawnFailed) return;
    clearInterval(timer);
    restoreSignals();
    stdoutFeeder.end();
    stderrFeeder.end();
    if (!result) {
      const evaluation = classifier.evaluate(Date.now(), {
        final: true,
        finalLabel: "before the dev server exited",
      });
      settle(evaluation, describeExit(code, signal));
    }
    pendingWrite.then(() => onExit(code, signal));
  });
  return { armed: true, child };
}

function printSummaryAndExit(result) {
  for (const line of formatLaunchEvidenceSummary(result)) console.log(line);
  if (result.status !== LAUNCH_EVIDENCE_STATUSES.running) {
    const hint =
      result.status === LAUNCH_EVIDENCE_STATUSES.bundleOnlyThenClosed
        ? " A startup crash with no client log is the signature of JavaScript that does not match the native modules inside the Expo Go build (react-native-worklets / react-native-reanimated); compare targetExpoGoIosVersion in expo-go-native-modules.json with the Expo Go build that fetched the bundle before investigating the app itself."
        : "";
    throw new Error(
      `Expo Go iOS launch evidence is ${result.status}; do not treat the preview as launching until the probe reports RUNNING.${hint}`,
    );
  }
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function main(argv) {
  const separator = argv.indexOf("--");
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
  const commandLine = separator === -1 ? [] : argv.slice(separator + 1);
  const stateDirectory = optionValue(ownArgs, "--state-dir") ?? undefined;

  if (ownArgs.includes("--arm")) {
    const armed = await armLaunchProbe({ stateDirectory });
    console.log(
      `Armed the Expo Go iOS launch-evidence probe (${armed.marker}). ` +
        `Restart the artifacts/chat-app: expo workflow once; that start logs redacted request evidence and ${INSPECTOR_DEBUG_NAMESPACE} output, ` +
        `classifies the launch within ${formatSeconds(armed.deviceTimeoutMs + armed.settleTimeoutMs)} s, and prints ${PROBE_LOG_PREFIX} lines. ` +
        `Then run this script with --report.`,
    );
    return;
  }
  if (ownArgs.includes("--disarm")) {
    const paths = await disarmLaunchProbe({ stateDirectory });
    console.log(`Disarmed the launch-evidence probe (${paths.marker}).`);
    return;
  }
  if (ownArgs.includes("--report")) {
    printSummaryAndExit(await readLaunchProbeResult({ stateDirectory }));
    return;
  }
  if (ownArgs.includes("--log-file")) {
    const logFile = optionValue(ownArgs, "--log-file");
    const text = await readFile(resolve(logFile), "utf8");
    const evaluation = classifyLaunchEvidence(text);
    printSummaryAndExit({ ...evaluation, mode: "log-file" });
    return;
  }
  if (ownArgs.includes("--launch")) {
    await launchDevServer({
      command: commandLine[0],
      args: commandLine.slice(1),
      stateDirectory,
    });
    return;
  }
  throw new Error(
    "Usage: preview-launch-evidence.mjs (--arm | --disarm | --report | --log-file <path> | --launch -- <command...>) [--state-dir <dir>]",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
