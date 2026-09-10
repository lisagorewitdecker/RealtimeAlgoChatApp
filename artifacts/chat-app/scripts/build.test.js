const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const buildScript = path.resolve(__dirname, "build.js");
const packageJson = require("../package.json");

function runPreflight(overrides = {}) {
  return spawnSync(process.execPath, [buildScript, "--preflight-only"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      SENTRY_DSN: "",
      EXPO_PUBLIC_SENTRY_DSN: "",
      ...overrides,
    },
  });
}

function runNativeBuildPreflight(overrides = {}) {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "chat-app-native-preflight-"),
  );
  const result = spawnSync("pnpm", ["run", "eas-build-pre-install"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      SENTRY_DSN: "",
      EXPO_PUBLIC_SENTRY_DSN: "",
      MOBILE_RELEASE_PREFLIGHT_OUTPUT_ROOT: outputRoot,
      ...overrides,
    },
  });

  return { outputRoot, result };
}

test("native production build hook accepts and maps managed SENTRY_DSN", (t) => {
  const sentinel = "https://managed-sentry-dsn.example/secret";
  const { outputRoot, result } = runNativeBuildPreflight({
    EXPO_PUBLIC_SENTRY_DSN: " ",
    SENTRY_DSN: sentinel,
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /crash reporting preflight passed/i);
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
  assert.match(
    fs.readFileSync(
      path.join(outputRoot, "constants", "releaseCrashReporting.ts"),
      "utf8",
    ),
    /SENTRY_RELEASE_PREFLIGHT_PASSED_V1/,
  );
  assert.equal(
    fs
      .readFileSync(path.join(outputRoot, ".env.local"), "utf8")
      .includes(sentinel),
    true,
  );
});

test("native production build hook accepts EXPO_PUBLIC_SENTRY_DSN", (t) => {
  const sentinel = "https://expo-public-sentry-dsn.example/secret";
  const { outputRoot, result } = runNativeBuildPreflight({
    EXPO_PUBLIC_SENTRY_DSN: sentinel,
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /crash reporting preflight passed/i);
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
  assert.equal(fs.existsSync(path.join(outputRoot, ".env.local")), false);
});

test("native production build hook blocks bundling without a Sentry DSN", (t) => {
  const { outputRoot, result } = runNativeBuildPreflight();
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const output = result.stdout + result.stderr;

  assert.equal(result.status, 1);
  assert.match(output, /SENTRY_DSN or EXPO_PUBLIC_SENTRY_DSN/);
  assert.match(
    output,
    /Configure one in the mobile-release environment before bundling/,
  );
  assert.doesNotMatch(output, /Building static Expo Go deployment/);
  assert.equal(
    fs.existsSync(
      path.join(outputRoot, "constants", "releaseCrashReporting.ts"),
    ),
    false,
  );
});

test("custom production bundler blocks before build work without a DSN", () => {
  const result = runPreflight();

  assert.equal(result.status, 1);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Building static Expo Go deployment/,
  );
});

test("development entrypoint remains independent of the release preflight", () => {
  assert.doesNotMatch(
    packageJson.scripts.dev,
    /preflight:release|native-build-preflight/,
  );
});
