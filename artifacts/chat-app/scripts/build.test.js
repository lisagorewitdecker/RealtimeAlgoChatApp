const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const buildScript = path.resolve(__dirname, "build.js");
const packageJson = require("../package.json");

function extractUrls(text) {
  return (text.match(/https?:\/\/[^\s'"]+/g) ?? []).map((value) =>
    value.replace(/[.,;:!?)}\]]+$/u, ""),
  );
}

function readEnvValue(filePath, key) {
  const line = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith(`${key}=`));
  return typeof line === "string"
    ? JSON.parse(line.slice(`${key}=`.length))
    : undefined;
}

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
      SENTRY_AUTH_TOKEN: "test-auth-token",
      SENTRY_RELEASE: "chat-app@1.0.0+test",
      SENTRY_DIST: "100",
      SENTRY_BUILD_ID: "build-test",
      MOBILE_RELEASE_PREFLIGHT_OUTPUT_ROOT: outputRoot,
      ...overrides,
    },
  });

  return { outputRoot, result };
}

test("native production build hook accepts and maps managed SENTRY_DSN", (t) => {
  const sentinel = "https://managed-sentry-dsn.example/secret";
  const authSentinel = "auth-token-must-not-be-written";
  const { outputRoot, result } = runNativeBuildPreflight({
    EXPO_PUBLIC_SENTRY_DSN: " ",
    SENTRY_DSN: sentinel,
    SENTRY_AUTH_TOKEN: authSentinel,
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /crash reporting preflight passed/i);
  assert.equal(
    extractUrls(result.stdout + result.stderr).some((value) => value === sentinel),
    false,
  );
  assert.equal((result.stdout + result.stderr).includes(authSentinel), false);
  assert.match(
    fs.readFileSync(
      path.join(outputRoot, "constants", "releaseCrashReporting.ts"),
      "utf8",
    ),
    /SENTRY_RELEASE_PREFLIGHT_PASSED_V1[\s\S]*chat-app@1\.0\.0\+test[\s\S]*100[\s\S]*build-test[\s\S]*RELEASE_BUILD_CREATED_AT = "20\d\d-/,
  );
  assert.equal(
    readEnvValue(path.join(outputRoot, ".env.local"), "EXPO_PUBLIC_SENTRY_DSN"),
    sentinel,
  );
  assert.equal(
    fs
      .readFileSync(
        path.join(outputRoot, "constants", "releaseCrashReporting.ts"),
        "utf8",
      )
      .includes(authSentinel),
    false,
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
  assert.equal(
    extractUrls(result.stdout + result.stderr).some((value) => value === sentinel),
    false,
  );
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

test("native production build hook blocks source-map upload without an auth token", (t) => {
  const { outputRoot, result } = runNativeBuildPreflight({
    SENTRY_DSN: "https://public-dsn.example/123",
    SENTRY_AUTH_TOKEN: "",
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SENTRY_AUTH_TOKEN, SENTRY_RELEASE, and SENTRY_DIST/);
  assert.equal(
    fs.existsSync(
      path.join(outputRoot, "constants", "releaseCrashReporting.ts"),
    ),
    false,
  );
});

test("native production build hook refuses best-effort source-map uploads", (t) => {
  const { outputRoot, result } = runNativeBuildPreflight({
    SENTRY_DSN: "https://public-dsn.example/123",
    SENTRY_ALLOW_FAILURE: "true",
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must fail when Sentry source-map upload/);
});

test("native production build hook requires candidate-bound build identity", (t) => {
  const { outputRoot, result } = runNativeBuildPreflight({
    SENTRY_DSN: "https://public-dsn.example/123",
    SENTRY_BUILD_ID: "",
    EAS_BUILD_ID: "",
  });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires EAS_BUILD_ID/);
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

test("development entrypoint preserves an explicit Expo key and falls back to the managed Vite key", () => {
  assert.match(
    packageJson.scripts.dev,
    /EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=.*EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.*VITE_CLERK_PUBLISHABLE_KEY/,
  );
});

// Expo Go 57 on iOS only loads a project from a dev server signed into the
// repl's Expo account, so the dev script signs Expo CLI in before Metro starts.
function devScriptSignInGuard() {
  const devScript = packageJson.scripts.dev;
  assert.match(devScript, /^sh -c '/, "dev script must start with the guard");
  // The guard is a single-quoted `sh -c` body; the first `' && ` closes it.
  const separator = devScript.indexOf("' && ");
  assert.notEqual(separator, -1, "dev script must chain the sign-in guard");
  return {
    guard: devScript.slice(0, separator + 1),
    start: devScript.slice(separator + "' && ".length),
  };
}

function runDevScriptSignInGuard(environmentOverrides) {
  const { guard } = devScriptSignInGuard();
  const environment = { ...process.env, ...environmentOverrides };
  for (const [key, value] of Object.entries(environmentOverrides)) {
    if (value === undefined) delete environment[key];
  }
  return spawnSync("sh", ["-c", `${guard} && echo METRO_WOULD_START`], {
    cwd: path.join(__dirname, ".."),
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("development entrypoint signs Expo CLI in from the managed session before starting Metro", () => {
  const { guard, start } = devScriptSignInGuard();
  assert.match(
    guard,
    /create-launch login --session "\$REPLIT_EXPO_SESSION_SECRET" \|\| true/,
  );
  assert.match(guard, /if \[ -n "\$REPLIT_EXPO_SESSION_SECRET" \]/);
  // create-launch writes ~/.expo/state.json atomically but never creates the
  // directory, so a fresh container must get it before the login runs.
  assert.match(
    guard,
    /mkdir -p "\$\{__UNSAFE_EXPO_HOME_DIRECTORY:-\$HOME\/\.expo\}" && pnpm exec create-launch login/,
  );
  assert.match(start, /pnpm exec expo start --localhost --port \$PORT$/);
  // Expo starts through the launch-evidence launcher so an armed probe can
  // instrument exactly one managed restart; unarmed it is a pass-through.
  assert.match(
    start,
    / node scripts\/preview-launch-evidence\.mjs --launch -- pnpm exec expo start --localhost --port \$PORT$/,
  );
  assert.equal(
    packageJson.devDependencies["create-launch"],
    "0.3.6",
    "create-launch must stay pinned to the exact version the Expo skill prescribes",
  );
});

test("development sign-in guard skips silently without a session and never blocks startup", () => {
  const skipped = runDevScriptSignInGuard({
    REPLIT_EXPO_SESSION_SECRET: undefined,
    EXPO_TOKEN: undefined,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout.trim(), "METRO_WOULD_START");
  assert.equal(skipped.stderr, "");

  const sentinel = "sentinel-invalid-expo-session";
  // Keep the rejected sentinel away from the real Expo CLI state file, and
  // start from a home directory that does not exist yet, like a fresh
  // container before Metro has created ~/.expo.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "expo-home-"));
  const freshExpoHome = path.join(scratch, "fresh-home", ".expo");
  try {
    const failedLogin = runDevScriptSignInGuard({
      REPLIT_EXPO_SESSION_SECRET: sentinel,
      EXPO_TOKEN: undefined,
      __UNSAFE_EXPO_HOME_DIRECTORY: freshExpoHome,
    });
    assert.equal(failedLogin.status, 0, failedLogin.stderr);
    assert.match(failedLogin.stdout, /METRO_WOULD_START/);
    assert.doesNotMatch(
      `${failedLogin.stdout}${failedLogin.stderr}`,
      new RegExp(sentinel),
    );
    assert.doesNotMatch(
      failedLogin.stderr,
      /ENOENT/,
      "the guard must create the Expo home directory before logging in",
    );
    assert.equal(
      fs.existsSync(freshExpoHome),
      true,
      "the guard must create the Expo home directory before logging in",
    );
    assert.equal(
      fs.existsSync(path.join(freshExpoHome, "state.json")),
      false,
      "a rejected session must not be persisted",
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
