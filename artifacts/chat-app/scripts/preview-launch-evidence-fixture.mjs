// Scripted dev-server stand-in for preview-launch-evidence.test.mjs.
//
// Prints the environment it received (to prove the launcher injects or
// withholds the diagnostics), a Metro ready line, and then the log signature of
// one scenario. Every device, host, account, and session value is a SENTINEL
// so the tests can prove none of them leak into the probe's own output.
// Scenarios that do not exit stay alive on an active handle until signalled,
// like the real dev server.
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.argv[2] ?? "silent";
const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const DEVICE =
  "name='SENTINEL-DEVICE-NAME (Simulator)', app=host.exp.Exponent, device=SENTINEL-DEVICE-ID, via=https://sentinel-host.replit.dev";
const CLOSE =
  "Connection closed to device='SENTINEL-DEVICE-NAME (Simulator)' for app='host.exp.Exponent' with code='1006' and reason=''.";

out(
  `fixture-env EXPO_DEV_REQUEST_LOG=${process.env.EXPO_DEV_REQUEST_LOG ?? "-"} ` +
    `DEBUG=${process.env.DEBUG ?? "-"}`,
);
out("Logged in as SENTINEL-ACCOUNT (session SENTINEL-SESSION-VALUE)");
out("Starting Metro Bundler");
out("› Metro: https://sentinel-host.replit.dev");

if (scenario === "exit-early") {
  process.exit(3);
}

if (scenario === "crash" || scenario === "running") {
  await delay(30);
  err(`2026-09-17T20:41:10.100Z Metro:InspectorProxy Got new device connection: ${DEVICE}`);
  await delay(30);
  out(
    "[dev-request] 2026-09-17T20:41:11.500Z GET 200 1200ms platform=ios client=Expo Go user-agent=[redacted] resource=bundle",
  );
  out("iOS Bundled 1200ms index.ts (1000 modules)");
  await delay(30);
  if (scenario === "crash") {
    err(`2026-09-17T20:41:15.600Z Metro:InspectorProxy ${CLOSE}`);
  } else {
    out("iOS  LOG  SENTINEL-APP-MESSAGE from https://sentinel-host.replit.dev");
    out(
      "[dev-request] 2026-09-17T20:41:12.000Z GET 200 12ms platform=- client=other user-agent=[redacted] resource=asset",
    );
  }
}

const keepAlive = setInterval(() => {}, 1_000);
const stop = (signal) => {
  out(`fixture-exit ${signal}`);
  clearInterval(keepAlive);
  process.exit(0);
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
