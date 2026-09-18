import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_DEVICE_TIMEOUT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  EXPO_GO_IOS_APP_ID,
  LAUNCH_EVIDENCE_STATUSES,
  PROBE_MARKER_FILENAME,
  PROBE_RESULT_FILENAME,
  PROBE_RESULT_SCHEMA,
  classifyLaunchEvidence,
  createLaunchEvidenceClassifier,
  formatLaunchEvidenceSummary,
  mergeDebugNamespaces,
} from "./preview-launch-evidence.mjs";

const SCRIPT = resolve(import.meta.dirname, "preview-launch-evidence.mjs");
const FIXTURE = resolve(import.meta.dirname, "preview-launch-evidence-fixture.mjs");
const { noDevice, bundleOnlyThenClosed, running, inconclusive } =
  LAUNCH_EVIDENCE_STATUSES;

// Log lines as the workflow log shows them: `debug` prefixes an ISO timestamp
// when stderr is not a TTY, and metro.config.js writes the redacted request
// log. Device names, ids, hosts, accounts, and sessions are sentinels.
const READY = "Starting Metro Bundler";
const SIGNED_IN = "Logged in as SENTINEL-ACCOUNT";
const CONNECT =
  "2026-09-17T20:41:10.100Z Metro:InspectorProxy Got new device connection: name='SENTINEL-DEVICE-NAME (Simulator)', app=host.exp.Exponent, device=SENTINEL-DEVICE-ID, via=https://sentinel-host.replit.dev";
const BUNDLE =
  "[dev-request] 2026-09-17T20:41:11.500Z GET 200 1200ms platform=ios client=Expo Go user-agent=[redacted] resource=bundle";
const BUNDLED = "iOS Bundled 1200ms index.ts (1000 modules)";
const closeLine = (code, at = "2026-09-17T20:41:15.600Z") =>
  `${at} Metro:InspectorProxy Connection closed to device='SENTINEL-DEVICE-NAME (Simulator)' for app='host.exp.Exponent' with code='${code}' and reason=''.`;
const CLOSE_1006 = closeLine(1006);
const APP_LOG = "iOS  LOG  SENTINEL-APP-MESSAGE https://sentinel-host.replit.dev/path?session=SENTINEL-SESSION-VALUE";
const APP_ERROR = "iOS  ERROR  SENTINEL-ERROR-MESSAGE";
const ASSET =
  "[dev-request] 2026-09-17T20:41:12.000Z GET 200 12ms platform=- client=other user-agent=[redacted] resource=asset";
const ASSET_EXPO_GO =
  "[dev-request] 2026-09-17T20:41:12.100Z GET 200 12ms platform=ios client=Expo Go user-agent=[redacted] resource=asset";
const MANIFEST_CURL =
  "[dev-request] 2026-09-17T20:41:09.000Z GET 200 5ms platform=ios client=curl user-agent=[redacted] resource=manifest";
const BUNDLE_BROWSER =
  "[dev-request] 2026-09-17T20:41:09.500Z GET 200 900ms platform=web client=browser user-agent=[redacted] resource=bundle";
const ANDROID_CONNECT =
  "2026-09-17T20:41:10.100Z Metro:InspectorProxy Got new device connection: name='SENTINEL-ANDROID', app=host.exp.exponent, device=SENTINEL-ANDROID-ID, via=https://sentinel-host.replit.dev";
const DEVTOOLS_CONNECT =
  "2026-09-17T20:41:10.200Z Metro:InspectorProxy Got new DevTools connection to device='SENTINEL-DEVICE-ID', page='1'";
const DEVTOOLS_CLOSE =
  "2026-09-17T20:41:10.300Z Metro:InspectorProxy Connection closed to DevTools for device='SENTINEL-DEVICE-ID' with code='1006' and reason=''.";
const SENTINEL_PATTERN = /SENTINEL|sentinel-host|Logged in as/;

function log(...lines) {
  return `${lines.join("\n")}\n`;
}

function assertRedacted(result) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, SENTINEL_PATTERN, "result must not carry log text");
  assert.doesNotMatch(serialized, /https?:/, "result must not carry URLs");
  for (const line of formatLaunchEvidenceSummary(result)) {
    assert.doesNotMatch(line, SENTINEL_PATTERN);
    assert.doesNotMatch(line, /https?:|@/);
  }
}

test("RUNNING: bundle served, connection stays open, and app output follows", () => {
  const result = classifyLaunchEvidence(
    log(SIGNED_IN, READY, CONNECT, BUNDLE, BUNDLED, APP_LOG, ASSET, ASSET_EXPO_GO),
  );
  assert.equal(result.status, running);
  assert.equal(result.passed, true);
  assert.deepEqual(
    {
      connections: result.observation.expoGoIosConnections,
      bundle: result.observation.iosBundleHttp200,
      logs: result.observation.iosClientLogLines,
      assets: result.observation.expoGoAssetRequests,
      close: result.observation.inspectorCloseCode,
    },
    { connections: 1, bundle: 1, logs: 1, assets: 2, close: null },
  );
  assert.match(result.reason, /1 iOS client log line and 2 asset requests followed/);
  assert.equal(
    formatLaunchEvidenceSummary(result)[0],
    "preview_launch_evidence=RUNNING",
  );
  assert.ok(
    formatLaunchEvidenceSummary(result).includes("bundle_to_close_seconds=n/a"),
  );
  assertRedacted(result);
});

test("BUNDLE_ONLY_THEN_CLOSED: the 2026-09-17 iPhone simulator signature", () => {
  const result = classifyLaunchEvidence(
    log(SIGNED_IN, READY, CONNECT, BUNDLE, BUNDLED, CLOSE_1006),
  );
  assert.equal(result.status, bundleOnlyThenClosed);
  assert.equal(result.passed, false);
  assert.equal(result.observation.inspectorCloseCode, 1006);
  assert.equal(result.observation.bundleToCloseSeconds, 4.1);
  assert.match(result.reason, /code 1006\) 4\.1 s after the bundle with no iOS client log or asset request/);
  const summary = formatLaunchEvidenceSummary(result);
  assert.ok(summary.includes("preview_launch_evidence=BUNDLE_ONLY_THEN_CLOSED"));
  assert.ok(summary.includes("inspector_close_code=1006"));
  assert.ok(summary.includes("bundle_to_close_seconds=4.1"));
  assertRedacted(result);
});

test("BUNDLE_ONLY_THEN_CLOSED: a bundle fetched before the inspector connection belongs to it", () => {
  const result = classifyLaunchEvidence(log(READY, BUNDLE, CONNECT, CLOSE_1006));
  assert.equal(result.status, bundleOnlyThenClosed);
  assert.equal(result.observation.iosBundleHttp200, 1);
});

test("BUNDLE_ONLY_THEN_CLOSED: TTY-style colored debug lines without timestamps", () => {
  const colored = (text) => `\u001b[36m  Metro:InspectorProxy \u001b[0m${text} \u001b[36m+4s\u001b[0m`;
  const result = classifyLaunchEvidence(
    log(
      READY,
      colored(
        "Got new device connection: name='SENTINEL-DEVICE-NAME', app=host.exp.Exponent, device=SENTINEL-DEVICE-ID, via=https://sentinel-host.replit.dev",
      ),
      BUNDLE,
      colored(
        "Connection closed to device='SENTINEL-DEVICE-NAME' for app='host.exp.Exponent' with code='1006' and reason=''.",
      ),
    ),
  );
  assert.equal(result.status, bundleOnlyThenClosed);
  assert.equal(result.observation.bundleToCloseSeconds, null);
  assert.ok(
    formatLaunchEvidenceSummary(result).includes("bundle_to_close_seconds=unknown"),
  );
  assertRedacted(result);
});

test("NO_DEVICE: browser, curl, Android Expo Go, and DevTools traffic is not an iOS device", () => {
  const result = classifyLaunchEvidence(
    log(
      SIGNED_IN,
      READY,
      MANIFEST_CURL,
      BUNDLE_BROWSER,
      ANDROID_CONNECT,
      DEVTOOLS_CONNECT,
      DEVTOOLS_CLOSE,
      "Android  LOG  not an iOS log",
      "Web  LOG  not an iOS log",
    ),
  );
  assert.equal(result.status, noDevice);
  assert.equal(result.passed, false);
  assert.equal(result.observation.expoGoIosConnections, 0);
  assert.equal(result.observation.otherInspectorConnections, 1);
  assert.equal(result.observation.requestLogLines, 2);
  assert.match(result.reason, new RegExp(`app=${EXPO_GO_IOS_APP_ID}`));
  assert.match(result.reason, /in the captured output\. 1 other inspector connection appeared/);
  assert.doesNotMatch(result.reason, /EXPO_DEV_REQUEST_LOG/);
  assertRedacted(result);
});

test("NO_DEVICE without any request-log line points at the missing request log", () => {
  const result = classifyLaunchEvidence(log(SIGNED_IN, READY));
  assert.equal(result.status, noDevice);
  assert.match(result.reason, /confirm EXPO_DEV_REQUEST_LOG=1 was active/);
  assert.equal(result.observation.metroReady, true);
});

test("the request-log hint is dropped when the launcher enabled the request log itself", () => {
  const result = classifyLaunchEvidence(log(SIGNED_IN, READY), { requestLogEnabled: true });
  assert.equal(result.status, noDevice);
  assert.doesNotMatch(result.reason, /EXPO_DEV_REQUEST_LOG/);
});

test("NO_DEVICE when Metro never became ready says so", () => {
  const result = classifyLaunchEvidence(log(SIGNED_IN, "some startup noise"));
  assert.equal(result.status, noDevice);
  assert.match(result.reason, /Metro never reported that it was running/);
  assert.ok(formatLaunchEvidenceSummary(result).includes("metro_ready=no"));
});

test("INCONCLUSIVE outcomes explain what was missing without passing", () => {
  const cases = [
    {
      name: "normal close",
      lines: [READY, CONNECT, BUNDLE, closeLine(1000)],
      reason: /closed normally \(code 1000\)/,
    },
    {
      name: "abnormal close after app output",
      lines: [READY, CONNECT, BUNDLE, APP_LOG, CLOSE_1006],
      reason: /after 1 app evidence line: the app started and then stopped/,
    },
    {
      name: "close before any bundle",
      lines: [READY, CONNECT, CLOSE_1006],
      reason: /before any iOS Expo Go bundle HTTP 200 was logged\. No redacted request-log lines/,
    },
    {
      name: "open connection without a bundle",
      lines: [READY, MANIFEST_CURL, CONNECT, APP_LOG],
      reason: /no iOS Expo Go bundle HTTP 200 was logged in the captured output\.$/,
    },
    {
      name: "error-level client logs",
      lines: [READY, CONNECT, BUNDLE, APP_LOG, APP_ERROR],
      reason: /1 error-level iOS client log line followed the bundle/,
    },
    {
      name: "bundle without any app output",
      lines: [READY, CONNECT, BUNDLE, BUNDLED],
      reason: /no iOS client log or asset request followed in the captured output/,
    },
  ];
  for (const testCase of cases) {
    const result = classifyLaunchEvidence(log(...testCase.lines));
    assert.equal(result.status, inconclusive, testCase.name);
    assert.equal(result.passed, false, testCase.name);
    assert.match(result.reason, testCase.reason, testCase.name);
    assertRedacted(result);
  }
});

test("app output logged before the session's bundle is not evidence that the bundle ran", () => {
  // A still-running previous bundle keeps logging and fetching assets while
  // Metro serves the new bundle; only output after the bundle 200 counts.
  const crashedAfterStaleOutput = classifyLaunchEvidence(
    log(READY, CONNECT, APP_LOG, ASSET_EXPO_GO, APP_ERROR, BUNDLE, BUNDLED, CLOSE_1006),
  );
  assert.equal(crashedAfterStaleOutput.status, bundleOnlyThenClosed);
  assert.equal(crashedAfterStaleOutput.passed, false);
  assert.deepEqual(
    {
      logs: crashedAfterStaleOutput.observation.iosClientLogLines,
      errors: crashedAfterStaleOutput.observation.iosClientErrorLines,
      assets: crashedAfterStaleOutput.observation.expoGoAssetRequests,
      before: crashedAfterStaleOutput.observation.iosLinesBeforeBundle,
    },
    { logs: 0, errors: 0, assets: 0, before: 3 },
  );
  assert.match(
    crashedAfterStaleOutput.reason,
    /the app quit during startup\. 3 iOS client log or asset lines logged before this bundle came from an earlier bundle and did not count\.$/,
  );
  assert.ok(
    formatLaunchEvidenceSummary(crashedAfterStaleOutput).includes(
      "ios_lines_before_bundle=3",
    ),
  );
  assertRedacted(crashedAfterStaleOutput);

  const stillOpenAfterStaleOutput = classifyLaunchEvidence(
    log(READY, CONNECT, APP_LOG, ASSET, BUNDLE, BUNDLED),
  );
  assert.equal(stillOpenAfterStaleOutput.status, inconclusive);
  assert.equal(stillOpenAfterStaleOutput.passed, false);
  assert.match(
    stillOpenAfterStaleOutput.reason,
    /no iOS client log or asset request followed in the captured output; the app cannot be confirmed as running\. 2 iOS client log or asset lines logged before this bundle/,
  );
  assertRedacted(stillOpenAfterStaleOutput);

  const ranAfterStaleOutput = classifyLaunchEvidence(
    log(READY, CONNECT, APP_LOG, BUNDLE, BUNDLED, APP_LOG),
  );
  assert.equal(ranAfterStaleOutput.status, running);
  assert.equal(ranAfterStaleOutput.observation.iosClientLogLines, 1);
  assert.equal(ranAfterStaleOutput.observation.iosLinesBeforeBundle, 1);
  assert.match(ranAfterStaleOutput.reason, /1 iOS client log line and 0 asset requests followed/);

  // The streaming classifier applies the same rule: stale output must not
  // settle a session as RUNNING before its bundle has even been served.
  const classifier = createLaunchEvidenceClassifier({ startedAt: 0 });
  classifier.observe(READY, 100);
  classifier.observe(CONNECT, 1_000);
  classifier.observe(APP_LOG, 1_500);
  classifier.observe(ASSET_EXPO_GO, 1_600);
  classifier.observe(BUNDLE, 2_000);
  assert.equal(classifier.evaluate(2_000 + DEFAULT_SETTLE_TIMEOUT_MS - 1).decided, false);
  const settled = classifier.evaluate(2_000 + DEFAULT_SETTLE_TIMEOUT_MS);
  assert.equal(settled.decided, true);
  assert.equal(settled.status, inconclusive);
  assert.equal(settled.observation.iosLinesBeforeBundle, 2);
});

test("the latest Expo Go iOS session decides", () => {
  const relaunched = classifyLaunchEvidence(
    log(READY, CONNECT, BUNDLE, CLOSE_1006, BUNDLE, CONNECT, APP_LOG, ASSET),
  );
  assert.equal(relaunched.status, running);
  assert.equal(relaunched.observation.expoGoIosConnections, 2);

  const crashedAfterRunning = classifyLaunchEvidence(
    log(READY, CONNECT, BUNDLE, APP_LOG, closeLine(1001), CONNECT, BUNDLE, CLOSE_1006),
  );
  assert.equal(crashedAfterRunning.status, bundleOnlyThenClosed);
  assert.equal(crashedAfterRunning.observation.expoGoIosConnections, 2);
});

test("only an iOS Expo Go bundle 200 counts as the bundle", () => {
  const result = classifyLaunchEvidence(
    log(
      READY,
      CONNECT,
      "[dev-request] 2026-09-17T20:41:11.500Z GET 200 1200ms platform=ios client=other user-agent=[redacted] resource=bundle",
      "[dev-request] 2026-09-17T20:41:11.600Z GET 404 3ms platform=ios client=Expo Go user-agent=[redacted] resource=bundle",
      "[dev-request] 2026-09-17T20:41:11.700Z GET 200 1200ms platform=android client=Expo Go user-agent=[redacted] resource=bundle",
      CLOSE_1006,
    ),
  );
  assert.equal(result.status, inconclusive);
  assert.equal(result.observation.iosBundleHttp200, 0);
  assert.equal(result.observation.requestLogLines, 3);
});

test("the streaming classifier waits for the device and settle budgets", () => {
  const startedAt = 1_000_000;
  const classifier = createLaunchEvidenceClassifier({
    startedAt,
    deviceTimeoutMs: 5_000,
    settleTimeoutMs: 2_000,
  });
  assert.equal(classifier.evaluate(startedAt + 4_999).decided, false);
  classifier.observe(READY, startedAt + 1_000);
  // Metro readiness restarts the device window.
  assert.equal(classifier.evaluate(startedAt + 5_500).decided, false);
  const timedOut = classifier.evaluate(startedAt + 6_000);
  assert.equal(timedOut.decided, true);
  assert.equal(timedOut.status, noDevice);
  assert.match(timedOut.reason, /within 5 s of Metro startup/);

  const settling = createLaunchEvidenceClassifier({
    startedAt,
    deviceTimeoutMs: 5_000,
    settleTimeoutMs: 2_000,
  });
  settling.observe(READY, startedAt + 100);
  settling.observe(CONNECT, startedAt + 200);
  settling.observe(BUNDLE, startedAt + 300);
  settling.observe(APP_LOG, startedAt + 400);
  assert.equal(settling.evaluate(startedAt + 2_299).decided, false);
  const settled = settling.evaluate(startedAt + 2_300);
  assert.equal(settled.decided, true);
  assert.equal(settled.status, running);
  assert.match(settled.reason, /stayed open within 2 s of the bundle/);

  const crashing = createLaunchEvidenceClassifier({ startedAt });
  crashing.observe(READY, startedAt + 100);
  crashing.observe(CONNECT, startedAt + 200);
  crashing.observe(BUNDLE, startedAt + 300);
  assert.equal(crashing.evaluate(startedAt + 400).decided, false);
  crashing.observe(CLOSE_1006, startedAt + 4_300);
  const crashed = crashing.evaluate(startedAt + 4_300);
  assert.equal(crashed.status, bundleOnlyThenClosed);
  assert.equal(crashed.observation.bundleToCloseSeconds, 4);
  assert.equal(crashed.observation.deviceTimeoutMs, DEFAULT_DEVICE_TIMEOUT_MS);
  assert.equal(crashed.observation.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
});

test("mergeDebugNamespaces adds the inspector namespace once", () => {
  assert.equal(mergeDebugNamespaces(undefined, "Metro:InspectorProxy"), "Metro:InspectorProxy");
  assert.equal(mergeDebugNamespaces("", "Metro:InspectorProxy"), "Metro:InspectorProxy");
  assert.equal(
    mergeDebugNamespaces("expo:*", "Metro:InspectorProxy"),
    "expo:*,Metro:InspectorProxy",
  );
  assert.equal(
    mergeDebugNamespaces("expo:*, Metro:InspectorProxy", "Metro:InspectorProxy"),
    "expo:*,Metro:InspectorProxy",
  );
});

// --- launcher integration -------------------------------------------------

function childEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const key of ["EXPO_DEV_REQUEST_LOG", "DEBUG", "NODE_TEST_CONTEXT"]) {
    if (!(key in overrides)) delete environment[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
  }
  return environment;
}

function runScript(args, { env, timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: resolve(import.meta.dirname, ".."),
      env: env ?? childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function startLauncher(stateDir, scenario, { env } = {}) {
  const child = spawn(
    process.execPath,
    [SCRIPT, "--launch", "--state-dir", stateDir, "--", process.execPath, FIXTURE, scenario],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: env ?? childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  let done = false;
  exited.then(() => (done = true));
  return {
    child,
    output,
    exited,
    async waitFor(pattern, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(output.stdout + output.stderr)) {
        if (done || Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${pattern}\n--- stdout ---\n${output.stdout}\n--- stderr ---\n${output.stderr}`,
          );
        }
        await delay(25);
      }
    },
    async terminate() {
      if (!done) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const exit = await exited;
      clearTimeout(timer);
      return exit;
    },
  };
}

function probeLines(stdout) {
  return stdout.split("\n").filter((line) => line.startsWith("[preview-launch-probe]"));
}

// Every launcher started inside the callback is terminated afterwards, even
// when an assertion fails, so a failing test cannot leave a fixture dev server
// holding the test process open.
async function withStateDir(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "preview-launch-probe-"));
  const launchers = [];
  const launch = (scenario, options) => {
    const launcher = startLauncher(stateDir, scenario, options);
    launchers.push(launcher);
    return launcher;
  };
  try {
    await run(stateDir, launch);
  } finally {
    await Promise.all(launchers.map((launcher) => launcher.terminate()));
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const PROBE_TIMEOUTS = {
  PREVIEW_LAUNCH_DEVICE_TIMEOUT_MS: "1500",
  PREVIEW_LAUNCH_SETTLE_TIMEOUT_MS: "400",
};

test("unarmed launches are a transparent pass-through", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    const launcher = launch("silent");
    await launcher.waitFor(/› Metro:/);
    await delay(300);
    assert.match(launcher.output.stdout, /fixture-env EXPO_DEV_REQUEST_LOG=- DEBUG=-/);
    assert.deepEqual(probeLines(launcher.output.stdout), []);
    const exit = await launcher.terminate();
    assert.match(launcher.output.stdout, /fixture-exit SIGTERM/, "SIGTERM must reach the dev server");
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(await exists(join(stateDir, PROBE_RESULT_FILENAME)), false);
  });
});

test("an armed launch instruments one restart, classifies a startup crash, and keeps the dev server running", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    const armed = await runScript(["--arm", "--state-dir", stateDir], {
      env: childEnvironment(PROBE_TIMEOUTS),
    });
    assert.equal(armed.code, 0, armed.stderr);
    assert.match(armed.stdout, /Restart the artifacts\/chat-app: expo workflow once/);
    assert.equal(await exists(join(stateDir, PROBE_MARKER_FILENAME)), true);

    const launcher = launch("crash", {
      env: childEnvironment({ DEBUG: "expo:start:*" }),
    });
    // The summary is written line by line; the "result written" line is last.
    await launcher.waitFor(/result written to/);
    assert.equal(
      await exists(join(stateDir, PROBE_MARKER_FILENAME)),
      false,
      "the marker is consumed by the launch that used it",
    );
    assert.match(
      launcher.output.stdout,
      /fixture-env EXPO_DEV_REQUEST_LOG=1 DEBUG=expo:start:\*,Metro:InspectorProxy/,
    );
    const lines = probeLines(launcher.output.stdout);
    assert.match(lines[0], /armed: this restart runs with EXPO_DEV_REQUEST_LOG=1 and DEBUG=Metro:InspectorProxy/);
    assert.ok(lines.includes("[preview-launch-probe] preview_launch_evidence=BUNDLE_ONLY_THEN_CLOSED"), lines.join("\n"));
    assert.ok(lines.includes("[preview-launch-probe] inspector_close_code=1006"));
    assert.ok(lines.includes("[preview-launch-probe] ios_bundle_http_200=1"));
    assert.ok(lines.includes("[preview-launch-probe] expo_go_ios_connections=1"));
    assert.ok(lines.some((line) => /bundle_to_close_seconds=\d/.test(line)));
    for (const line of lines) {
      assert.doesNotMatch(line, SENTINEL_PATTERN, "probe output must stay redacted");
    }
    // The mirrored dev-server output itself is untouched.
    assert.match(launcher.output.stderr, /Got new device connection: name='SENTINEL-DEVICE-NAME/);

    await delay(200);
    const resultPath = join(stateDir, PROBE_RESULT_FILENAME);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.schema, PROBE_RESULT_SCHEMA);
    assert.equal(result.status, bundleOnlyThenClosed);
    assert.equal(result.passed, false);
    assert.equal(result.mode, "live");
    assert.doesNotMatch(JSON.stringify(result), SENTINEL_PATTERN);

    assert.doesNotMatch(launcher.output.stdout, /fixture-exit/, "the dev server keeps running after classification");
    const exit = await launcher.terminate();
    assert.match(launcher.output.stdout, /fixture-exit SIGTERM/);
    assert.deepEqual(exit, { code: 0, signal: null });

    const report = await runScript(["--report", "--state-dir", stateDir]);
    assert.equal(report.code, 1);
    assert.match(report.stdout, /^preview_launch_evidence=BUNDLE_ONLY_THEN_CLOSED$/m);
    assert.match(report.stderr, /launch evidence is BUNDLE_ONLY_THEN_CLOSED; do not treat the preview as launching/);
    assert.doesNotMatch(report.stdout + report.stderr, SENTINEL_PATTERN);

    // The marker was one-shot: the next launch is a pass-through again.
    const second = launch("silent");
    await second.waitFor(/› Metro:/);
    await delay(200);
    assert.match(second.output.stdout, /fixture-env EXPO_DEV_REQUEST_LOG=- DEBUG=-/);
    assert.deepEqual(probeLines(second.output.stdout), []);
    await second.terminate();
  });
});

test("an armed launch reports RUNNING only after the settle budget and --report then passes", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    const armed = await runScript(["--arm", "--state-dir", stateDir], {
      env: childEnvironment(PROBE_TIMEOUTS),
    });
    assert.equal(armed.code, 0, armed.stderr);
    const launcher = launch("running");
    await launcher.waitFor(/iOS {2}LOG/);
    assert.doesNotMatch(launcher.output.stdout, /preview_launch_evidence=/, "must wait for the settle budget");
    await launcher.waitFor(/preview_launch_evidence=RUNNING/);
    await launcher.waitFor(/result written to/);
    const lines = probeLines(launcher.output.stdout);
    assert.ok(lines.includes("[preview-launch-probe] ios_client_log_lines=1"), lines.join("\n"));
    assert.ok(lines.includes("[preview-launch-probe] expo_go_asset_requests=1"));
    assert.ok(lines.includes("[preview-launch-probe] inspector_close_code=none"));
    for (const line of lines) assert.doesNotMatch(line, SENTINEL_PATTERN);
    await delay(200);
    await launcher.terminate();

    const report = await runScript(["--report", "--state-dir", stateDir]);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /^preview_launch_evidence=RUNNING$/m);
    assert.match(report.stdout, /^reason=Expo Go iOS downloaded the bundle, the inspector connection stayed open within 0\.4 s of the bundle/m);
    assert.doesNotMatch(report.stdout, SENTINEL_PATTERN);
  });
});

test("an armed launch with no device reports NO_DEVICE after the device budget", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    await runScript(["--arm", "--state-dir", stateDir], {
      env: childEnvironment(PROBE_TIMEOUTS),
    });
    const startedAt = Date.now();
    const launcher = launch("silent");
    await launcher.waitFor(/preview_launch_evidence=NO_DEVICE/);
    assert.ok(Date.now() - startedAt >= 1_400, "must wait for the device budget");
    await launcher.waitFor(/result written to/);
    const lines = probeLines(launcher.output.stdout);
    assert.ok(lines.includes("[preview-launch-probe] metro_ready=yes"));
    assert.ok(lines.includes("[preview-launch-probe] expo_go_ios_connections=0"));
    assert.ok(lines.some((line) => /reason=No Expo Go iOS device \(app=host\.exp\.Exponent\) connected to the Metro inspector within 1\.5 s of Metro startup\.$/.test(line)), lines.join("\n"));
    assert.ok(lines.includes("[preview-launch-probe] request_log_lines=0"));
    const exit = await launcher.terminate();
    assert.deepEqual(exit, { code: 0, signal: null });
  });
});

test("a dev server that exits before any evidence is reported with its exit status", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    await runScript(["--arm", "--state-dir", stateDir], {
      env: childEnvironment(PROBE_TIMEOUTS),
    });
    const launcher = launch("exit-early");
    const exit = await launcher.exited;
    assert.deepEqual(exit, { code: 3, signal: null });
    const lines = probeLines(launcher.output.stdout);
    assert.ok(lines.includes("[preview-launch-probe] preview_launch_evidence=NO_DEVICE"), lines.join("\n"));
    assert.ok(lines.includes("[preview-launch-probe] dev_server_exit=code:3"));
    assert.ok(lines.some((line) => /reason=.*before the dev server exited\./.test(line)));
    const result = JSON.parse(await readFile(join(stateDir, PROBE_RESULT_FILENAME), "utf8"));
    assert.equal(result.devServerExit, "code:3");
    assert.equal(result.status, noDevice);
  });
});

test("--disarm removes the marker and --report without a result fails clearly", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    await runScript(["--arm", "--state-dir", stateDir]);
    const marker = JSON.parse(await readFile(join(stateDir, PROBE_MARKER_FILENAME), "utf8"));
    assert.equal(marker.deviceTimeoutMs, DEFAULT_DEVICE_TIMEOUT_MS);
    assert.equal(marker.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
    const disarmed = await runScript(["--disarm", "--state-dir", stateDir]);
    assert.equal(disarmed.code, 0);
    assert.equal(await exists(join(stateDir, PROBE_MARKER_FILENAME)), false);

    const report = await runScript(["--report", "--state-dir", stateDir]);
    assert.equal(report.code, 1);
    assert.match(report.stderr, /No launch-evidence result at .*Arm the probe with --arm/);

    const badTimeout = await runScript(["--arm", "--state-dir", stateDir], {
      env: childEnvironment({ PREVIEW_LAUNCH_SETTLE_TIMEOUT_MS: "1_000" }),
    });
    assert.equal(badTimeout.code, 1);
    assert.match(badTimeout.stderr, /PREVIEW_LAUNCH_SETTLE_TIMEOUT_MS must be a positive finite number/);
  });
});

test("probe records with duplicate JSON fields are rejected before they are read", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    // A result whose duplicated status would otherwise resolve to the last
    // value (RUNNING) must fail closed without echoing the file contents.
    await writeFile(
      join(stateDir, PROBE_RESULT_FILENAME),
      `{"schema":"${PROBE_RESULT_SCHEMA}","status":"BUNDLE_ONLY_THEN_CLOSED","status":"RUNNING","reason":"SENTINEL-DUPLICATE-REASON"}\n`,
    );
    const report = await runScript(["--report", "--state-dir", stateDir]);
    assert.equal(report.code, 1);
    assert.match(
      report.stderr,
      /Launch-evidence probe JSON contains duplicate fields \(preview-launch-evidence\.json\)\./,
    );
    assert.doesNotMatch(report.stdout + report.stderr, /RUNNING|SENTINEL/);
    await rm(join(stateDir, PROBE_RESULT_FILENAME));

    // A duplicated marker is consumed (one managed restart) and refused rather
    // than arming the launcher with whichever timeout happened to come last.
    await writeFile(
      join(stateDir, PROBE_MARKER_FILENAME),
      '{"schema":"ios-preview-launch-probe-marker/v1","deviceTimeoutMs":1000,"deviceTimeoutMs":5}\n',
    );
    const launcher = launch("running");
    const exit = await launcher.exited;
    assert.equal(exit.code, 1);
    assert.match(
      launcher.output.stderr,
      /preview-launch-probe\.armed is not valid JSON \(Launch-evidence probe JSON contains duplicate fields \(preview-launch-probe\.armed\)\.\); run --arm again/,
    );
    assert.equal(await exists(join(stateDir, PROBE_MARKER_FILENAME)), false);
  });
});

test("--log-file classifies captured workflow output and exits non-zero unless RUNNING", { timeout: 60_000 }, async () => {
  await withStateDir(async (stateDir, launch) => {
    const crashLog = join(stateDir, "crash.log");
    await writeFile(crashLog, log(SIGNED_IN, READY, CONNECT, BUNDLE, BUNDLED, CLOSE_1006));
    const crash = await runScript(["--log-file", crashLog]);
    assert.equal(crash.code, 1);
    assert.match(crash.stdout, /^preview_launch_evidence=BUNDLE_ONLY_THEN_CLOSED$/m);
    assert.doesNotMatch(crash.stdout + crash.stderr, SENTINEL_PATTERN);

    const runningLog = join(stateDir, "running.log");
    await writeFile(runningLog, log(SIGNED_IN, READY, CONNECT, BUNDLE, APP_LOG, ASSET));
    const healthy = await runScript(["--log-file", runningLog]);
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.match(healthy.stdout, /^preview_launch_evidence=RUNNING$/m);

    const usage = await runScript([]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage: preview-launch-evidence\.mjs/);
  });
});
