import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyDevServerSignIn,
  createHandoffPreflightRecord,
  formatDevServerSignIn,
  formatHandoffPreflight,
  getPublicPreviewManifestUrl,
  manifestHasSignedInDeveloper,
  parsePreviewTimeout,
  requestLocalHandoffProbe,
  requestPublicPreviewManifest,
  readAndValidateHandoffPreflight,
  validateHandoffPreflightRecord,
  writeHandoffPreflight,
} from "./validate-preview-startup.mjs";

const previewEnvironment = {
  PREVIEW_PUBLIC_URL: "https://preview.example.test/expo",
};
const validatorPath = join(
  import.meta.dirname,
  "validate-preview-startup.mjs",
);

test("uses defaults only when preview timeout environment values are absent", () => {
  assert.equal(
    parsePreviewTimeout("PREVIEW_STARTUP_TIMEOUT_MS", undefined, 30_000),
    30_000,
  );
  assert.equal(
    parsePreviewTimeout("PREVIEW_HANDOFF_TIMEOUT_MS", null, 60_000),
    60_000,
  );
  assert.equal(
    parsePreviewTimeout("PREVIEW_PUBLIC_TIMEOUT_MS", undefined, 15_000),
    15_000,
  );
});

test("accepts positive finite preview timeout values", () => {
  for (const [name, value] of [
    ["PREVIEW_STARTUP_TIMEOUT_MS", "1000"],
    ["PREVIEW_HANDOFF_TIMEOUT_MS", "40"],
    ["PREVIEW_PUBLIC_TIMEOUT_MS", "25.5"],
  ]) {
    assert.equal(parsePreviewTimeout(name, value, 999), Number(value));
  }
});

test("rejects malformed and non-positive preview timeout values", () => {
  for (const name of [
    "PREVIEW_STARTUP_TIMEOUT_MS",
    "PREVIEW_HANDOFF_TIMEOUT_MS",
    "PREVIEW_PUBLIC_TIMEOUT_MS",
  ]) {
    for (const value of ["", "not-a-number", "2_000", "0", "-1", "Infinity"]) {
      assert.throws(
        () => parsePreviewTimeout(name, value, 999),
        (error) => {
          assert.equal(
            error.message,
            `${name} must be a positive finite number of milliseconds.`,
          );
          return true;
        },
      );
    }
  }
});

// Never a real value: the tests only prove it stays out of every message.
const SESSION_SECRET_SENTINEL = "sentinel-expo-session-secret-value";
const SIGNED_IN_ACCOUNT = "replit-private-test-account";

function mockFetch(response) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return response;
  };

  return {
    get request() {
      return request;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function runLiveMetroTimeoutFixture(fixtureName, expectedResource) {
  const directory = mkdtempSync(join(tmpdir(), "preview-live-timeout-"));
  const preloadPath = join(directory, "mock-public-preview.mjs");
  writeFileSync(
    preloadPath,
    `const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://public-preview.test/")) {
    return new Response(
      JSON.stringify({
        launchAsset: {
          url: "https://public-preview.test/_expo/static/js/bundle",
        },
      }),
      { status: 200 },
    );
  }
  return originalFetch(url, options);
};
`,
    "utf8",
  );

  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [validatorPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import ${preloadPath}`,
        ]
          .filter(Boolean)
          .join(" "),
        PREVIEW_PUBLIC_URL: "https://public-preview.test/expo",
        PREVIEW_PUBLIC_TIMEOUT_MS: "100",
        PREVIEW_HANDOFF_TIMEOUT_MS: "40",
        PREVIEW_STARTUP_TIMEOUT_MS: "1000",
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureName,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 4_000,
    });
    const output =
      result.stdout.toString() + result.stderr.toString();

    assert.notEqual(
      result.error?.code,
      "ETIMEDOUT",
      `${fixtureName} left the handoff command running indefinitely`,
    );
    assert.notEqual(result.status, 0, output);
    assert.ok(
      Date.now() - startedAt < 3_000,
      `${fixtureName} exceeded the bounded recovery window`,
    );
    assert.match(output, /public_manifest_reachability=PASS/);
    assert.match(output, /local_handoff_probe=FAIL/);
    assert.match(output, expectedResource);
    assert.match(output, /40ms configured local handoff deadline/);
    assert.match(output, /request aborted by deadline/);
    assert.match(
      output,
      /Restart or repair the managed Chat App\/Expo workflow/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runMalformedPreviewConfigurationCli(setting, value) {
  const directory = mkdtempSync(join(tmpdir(), "preview-malformed-config-cli-"));
  const markerPath = join(directory, "unexpected-public-request.marker");
  const preloadPath = join(directory, "reject-public-request.mjs");

  writeFileSync(
    preloadPath,
    `import { appendFileSync } from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
globalThis.fetch = async () => {
  appendFileSync(markerPath, "public request attempted\\n");
  throw new Error("public request should not be attempted");
};
`,
    "utf8",
  );

  try {
    const environment = {
      ...process.env,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import ${preloadPath}`,
      ]
        .filter(Boolean)
        .join(" "),
      PREVIEW_PUBLIC_TIMEOUT_MS: "1000",
      PREVIEW_HANDOFF_TIMEOUT_MS: "1000",
      PREVIEW_STARTUP_TIMEOUT_MS: "1000",
      PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    };
    delete environment.PREVIEW_PUBLIC_URL;
    delete environment.REPLIT_EXPO_DEV_DOMAIN;
    environment[setting] = value;

    const result = spawnSync(process.execPath, [validatorPath], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const output =
      result.stdout.toString() + result.stderr.toString();

    assert.notEqual(
      result.error?.code,
      "ETIMEDOUT",
      `${setting} left the preview validation command running indefinitely`,
    );
    assert.notEqual(result.status, 0, output);
    assert.match(
      output,
      new RegExp(
        `Public Expo preview manifest URL configuration from ${setting} is invalid`,
      ),
    );
    assert.match(output, new RegExp(`\\b${setting}\\b`));
    assert.equal(
      existsSync(markerPath),
      false,
      `${setting} attempted a public request before reporting its malformed configuration`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts a public HTTP 200 manifest and sends the Android Expo header", async () => {
  const fetchMock = mockFetch(
    new Response(
      JSON.stringify({
        launchAsset: {
          url: "https://preview.example.test/_expo/static/js/bundle",
        },
      }),
      { status: 200 },
    ),
  );

  try {
    const result = await requestPublicPreviewManifest(
      1_000,
      previewEnvironment,
    );

    assert.match(result.outcome, /^public manifest HTTP 200 \(\d+ bytes\)$/);
    assert.equal(
      String(fetchMock.request.url),
      "https://preview.example.test/expo/",
    );
    assert.deepEqual(fetchMock.request.options.headers, {
      Accept: "application/json",
      "expo-platform": "android",
      "user-agent": "Expo/57.0.0 (preview-validation)",
    });
  } finally {
    fetchMock.restore();
  }
});

test("accepts a public HTTP 200 manifest and sends the iOS Expo header", async () => {
  const fetchMock = mockFetch(
    new Response(
      JSON.stringify({
        launchAsset: {
          url: "https://preview.example.test/_expo/static/js/bundle",
        },
      }),
      { status: 200 },
    ),
  );

  try {
    const result = await requestPublicPreviewManifest(
      1_000,
      previewEnvironment,
      "ios",
    );

    assert.equal(fetchMock.request.options.headers["expo-platform"], "ios");
    assert.equal(result.signedInDeveloper, false);
  } finally {
    fetchMock.restore();
  }
});

test("public manifest probe reports a signed-in dev server without echoing the account", async () => {
  const fetchMock = mockFetch(
    new Response(
      JSON.stringify({
        extra: {
          scopeKey: "@anonymous/chat-app-00000000-0000-0000-0000-000000000000",
          expoGo: { username: SIGNED_IN_ACCOUNT },
        },
        launchAsset: {
          url: "https://preview.example.test/_expo/static/js/bundle",
        },
      }),
      { status: 200 },
    ),
  );

  try {
    const result = await requestPublicPreviewManifest(
      1_000,
      previewEnvironment,
      "ios",
    );

    assert.equal(result.signedInDeveloper, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SIGNED_IN_ACCOUNT));
  } finally {
    fetchMock.restore();
  }
});

async function withLocalManifestServer(manifest, run) {
  const observedPlatforms = [];
  const server = createServer((request, response) => {
    observedPlatforms.push(request.headers["expo-platform"]);
    response.setHeader("content-type", "application/json");
    if (request.url === "/") {
      response.end(JSON.stringify(manifest));
      return;
    }
    response.setHeader("content-type", "application/javascript");
    response.end("console.log('ios');");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");

  try {
    return await run(address.port, observedPlatforms);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("local iOS handoff probe requests both manifest and bundle with the iOS header", async () => {
  await withLocalManifestServer(
    {
      launchAsset: {
        url: "https://preview.example.test/_expo/static/js/ios-bundle",
      },
    },
    async (port, observedPlatforms) => {
      const result = await requestLocalHandoffProbe(port, 1_000, "ios");
      assert.match(result.manifest, /^manifest HTTP 200/);
      assert.match(result.bundle, /^bundle HTTP 200/);
      assert.deepEqual(observedPlatforms, ["ios", "ios"]);
      assert.equal(result.signedInDeveloper, false);
    },
  );
});

test("local handoff probe detects the signed-in account field without echoing it", async () => {
  await withLocalManifestServer(
    {
      extra: { expoGo: { username: SIGNED_IN_ACCOUNT } },
      launchAsset: {
        url: "https://preview.example.test/_expo/static/js/ios-bundle",
      },
    },
    async (port) => {
      const result = await requestLocalHandoffProbe(port, 1_000, "ios");
      assert.equal(result.signedInDeveloper, true);
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(SIGNED_IN_ACCOUNT),
      );
    },
  );
});

test("manifest sign-in detection keys on the Expo Go username field only", () => {
  assert.equal(
    manifestHasSignedInDeveloper({
      extra: { expoGo: { username: SIGNED_IN_ACCOUNT } },
    }),
    true,
  );
  // Expo CLI omits the field for anonymous servers; the scope key stays
  // anonymous without an EAS project even when the CLI is signed in.
  assert.equal(
    manifestHasSignedInDeveloper({
      extra: {
        scopeKey: "@anonymous/chat-app-00000000-0000-0000-0000-000000000000",
        expoGo: { developer: { tool: "expo-cli" } },
      },
    }),
    false,
  );
  assert.equal(
    manifestHasSignedInDeveloper({ extra: { expoGo: { username: "" } } }),
    false,
  );
  assert.equal(
    manifestHasSignedInDeveloper({
      extra: { expoGo: { username: "anonymous" } },
    }),
    false,
  );
  assert.equal(manifestHasSignedInDeveloper(null), false);
  assert.equal(manifestHasSignedInDeveloper({}), false);
});

test("dev server sign-in passes when both served manifests carry a signed-in account", () => {
  for (const environment of [
    { REPLIT_EXPO_SESSION_SECRET: SESSION_SECRET_SENTINEL },
    {},
  ]) {
    const signIn = classifyDevServerSignIn(
      { localSignedIn: true, publicSignedIn: true },
      environment,
    );
    assert.equal(signIn.status, "SIGNED_IN");
    assert.equal(signIn.severity, "pass");
    assert.equal(
      formatDevServerSignIn(signIn),
      "dev_server_sign_in=SIGNED_IN; evidence=public and local Expo Go manifests both carry a signed-in Expo account (extra.expoGo.username present)",
    );
  }
});

test("dev server sign-in fails when the session secret is set but a manifest is anonymous", () => {
  const environment = { REPLIT_EXPO_SESSION_SECRET: SESSION_SECRET_SENTINEL };

  const localOnly = classifyDevServerSignIn(
    { localSignedIn: false, publicSignedIn: true },
    environment,
  );
  assert.equal(localOnly.status, "ANONYMOUS");
  assert.equal(localOnly.severity, "fail");
  assert.match(
    localOnly.evidence,
    /^REPLIT_EXPO_SESSION_SECRET is set but the local Expo Go manifest is anonymous \(no extra\.expoGo\.username\)\./,
  );
  assert.match(localOnly.evidence, /create-launch login step is missing or failed/);
  assert.match(localOnly.evidence, /"Logged in as"/);
  assert.match(localOnly.evidence, /restart the managed Chat App\/Expo workflow/);

  const publicOnly = classifyDevServerSignIn(
    { localSignedIn: true, publicSignedIn: false },
    environment,
  );
  assert.equal(publicOnly.severity, "fail");
  assert.match(publicOnly.evidence, /the public Expo Go manifest is anonymous/);

  const both = classifyDevServerSignIn(
    { localSignedIn: false, publicSignedIn: false },
    environment,
  );
  assert.equal(both.severity, "fail");
  assert.match(
    both.evidence,
    /the public and local Expo Go manifest is anonymous/,
  );

  // A probe that never reported sign-in state must not pass the gate.
  const missing = classifyDevServerSignIn({}, environment);
  assert.equal(missing.severity, "fail");
  assert.match(
    missing.evidence,
    /the public and local Expo Go manifest is anonymous/,
  );

  for (const signIn of [localOnly, publicOnly, both, missing]) {
    const line = formatDevServerSignIn(signIn);
    assert.match(line, /^dev_server_sign_in=ANONYMOUS; evidence=/);
    assert.doesNotMatch(line, new RegExp(SESSION_SECRET_SENTINEL));
  }
});

test("dev server sign-in only warns when no session secret is configured", () => {
  for (const environment of [{}, { REPLIT_EXPO_SESSION_SECRET: "" }]) {
    const signIn = classifyDevServerSignIn(
      { localSignedIn: false, publicSignedIn: false },
      environment,
    );
    assert.equal(signIn.status, "ANONYMOUS");
    assert.equal(signIn.severity, "warn");
    assert.match(
      signIn.evidence,
      /^REPLIT_EXPO_SESSION_SECRET is unset, so the public and local Expo Go manifest is anonymous/,
    );
    assert.match(signIn.evidence, /iOS Expo Go 57 cannot load the app/);
  }
});

test("dev server sign-in output never contains the session secret", () => {
  const environment = { REPLIT_EXPO_SESSION_SECRET: SESSION_SECRET_SENTINEL };
  const combinations = [
    { localSignedIn: true, publicSignedIn: true },
    { localSignedIn: false, publicSignedIn: true },
    { localSignedIn: true, publicSignedIn: false },
    { localSignedIn: false, publicSignedIn: false },
  ];

  for (const combination of combinations) {
    const signIn = classifyDevServerSignIn(combination, environment);
    const serialized = `${formatDevServerSignIn(signIn)} ${JSON.stringify(signIn)}`;
    assert.doesNotMatch(serialized, new RegExp(SESSION_SECRET_SENTINEL));
    assert.doesNotMatch(serialized, /sessionSecret/);
  }
});

test("rejects any response that is not exactly HTTP 200 with recovery guidance", async () => {
  const fetchMock = mockFetch(
    new Response("preview unavailable", { status: 502 }),
  );

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, previewEnvironment),
      (error) => {
        assert.match(
          error.message,
          /Public Expo preview manifest check failed: public manifest HTTP 502/,
        );
        assert.match(
          error.message,
          /Restart or repair the managed Chat App\/Expo workflow/,
        );
        return true;
      },
    );
  } finally {
    fetchMock.restore();
  }
});

test("reports public manifest request failures with recovery guidance", async () => {
  const fetchMock = mockFetch(
    Promise.reject(
      new Error("fetch failed: connect ETIMEDOUT preview.example.test:443"),
    ),
  );

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, previewEnvironment),
      (error) => {
        assert.match(
          error.message,
          /Public Expo preview manifest check failed before a response: fetch failed: connect ETIMEDOUT preview\.example\.test:443/,
        );
        assert.match(
          error.message,
          /Restart or repair the managed Chat App\/Expo workflow/,
        );
        return true;
      },
    );
  } finally {
    fetchMock.restore();
  }
});

test(
  "aborts a stalled public manifest request at its deadline with recovery guidance",
  { timeout: 1_000 },
  async () => {
    const originalFetch = globalThis.fetch;
    let abortObserved = false;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            reject(new Error("request aborted by deadline"));
          },
          { once: true },
        );
      });
    };

    try {
      await assert.rejects(
        requestPublicPreviewManifest(25, previewEnvironment),
        (error) => {
          assert.match(error.message, /aborted by deadline/i);
          assert.match(error.message, /deadline|abort/i);
          assert.match(
            error.message,
            /Restart or repair the managed Chat App\/Expo workflow/,
          );
          return true;
        },
      );
      assert.equal(abortObserved, true);
      assert.equal(request.options.signal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "CLI saves a redacted failed public boundary when the public probe times out",
  { timeout: 5_000 },
  () => {
    const directory = mkdtempSync(
      join(tmpdir(), "preview-handoff-timeout-cli-"),
    );
    const outputPath = join(directory, "android-preview-preflight.json");
    const stdoutPath = join(directory, "validator.stdout.log");
    const stderrPath = join(directory, "validator.stderr.log");
    const preloadPath = join(directory, "stall-public-fetch.mjs");
    writeFileSync(
      preloadPath,
      `const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://public-preview.test/")) {
    await new Promise((resolve, reject) => {
      const signal = options.signal;
      if (!signal) {
        reject(new Error("test fetch requires an abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("request aborted by deadline"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("request aborted by deadline")),
        { once: true },
      );
    });
  }
  return originalFetch(url, options);
};
`,
      "utf8",
    );

    try {
      const stdout = openSync(stdoutPath, "w");
      const stderr = openSync(stderrPath, "w");
      let result;
      try {
        result = spawnSync(
          process.execPath,
          [
            validatorPath,
            "--platform",
            "android",
            "--record-output",
            outputPath,
          ],
          {
            env: {
              ...process.env,
              NODE_OPTIONS: [
                process.env.NODE_OPTIONS,
                `--import ${preloadPath}`,
              ]
                .filter(Boolean)
                .join(" "),
              PREVIEW_PUBLIC_URL:
                "https://public-preview.test/private-path?token=private-secret",
              PREVIEW_PUBLIC_TIMEOUT_MS: "25",
              PREVIEW_STARTUP_TIMEOUT_MS: "2000",
              PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
            },
            stdio: ["ignore", stdout, stderr],
          },
        );
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
      const output =
        readFileSync(stdoutPath, "utf8") + readFileSync(stderrPath, "utf8");

      assert.notEqual(result.status, 0, output);
      const record = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.doesNotThrow(() => validateHandoffPreflightRecord(record));
      assert.equal(
        record.boundaries.publicManifestReachability.status,
        "FAIL",
      );
      assert.equal(record.boundaries.localHandoffProbe.status, "NOT_RUN");
      assert.equal(record.boundaries.expoGoLaunch.status, "NOT_ASSESSED");
      assert.equal(
        record.boundaries.serverNativeRequestEvidence.status,
        "NOT_ASSESSED",
      );
      assert.match(output, /public_manifest_reachability=FAIL/);
      assert.match(
        output,
        /Restart or repair the managed Chat App\/Expo workflow/,
      );
      assert.doesNotMatch(
        output,
        /public-preview\.test|private-path|private-secret|token=/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI saves a redacted failed local boundary when the local bundle probe times out",
  { timeout: 5_000 },
  () => {
    const directory = mkdtempSync(
      join(tmpdir(), "preview-handoff-local-timeout-cli-"),
    );
    const outputPath = join(directory, "android-preview-preflight.json");
    const stdoutPath = join(directory, "validator.stdout.log");
    const stderrPath = join(directory, "validator.stderr.log");
    const preloadPath = join(directory, "stall-local-bundle-fetch.mjs");
    writeFileSync(
      preloadPath,
      `const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const requestUrl = new URL(String(url));
  if (requestUrl.origin === "https://public-preview.test") {
    return new Response(
      JSON.stringify({
        launchAsset: {
          url: "https://public-preview.test/_expo/static/js/bundle",
        },
      }),
      { status: 200 },
    );
  }
  if (
    requestUrl.hostname === "127.0.0.1" &&
    requestUrl.pathname === "/_expo/static/js/bundle"
  ) {
    await new Promise((resolve, reject) => {
      const signal = options.signal;
      if (!signal) {
        reject(new Error("test fetch requires an abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("request aborted by deadline"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("request aborted by deadline")),
        { once: true },
      );
    });
  }
  return originalFetch(url, options);
};
`,
      "utf8",
    );

    try {
      const stdout = openSync(stdoutPath, "w");
      const stderr = openSync(stderrPath, "w");
      let result;
      try {
        result = spawnSync(
          process.execPath,
          [
            validatorPath,
            "--platform",
            "android",
            "--record-output",
            outputPath,
          ],
          {
            env: {
              ...process.env,
              NODE_OPTIONS: [
                process.env.NODE_OPTIONS,
                `--import ${preloadPath}`,
              ]
                .filter(Boolean)
                .join(" "),
              PREVIEW_PUBLIC_URL:
                "https://public-preview.test/private-path?token=private-secret",
              PREVIEW_PUBLIC_TIMEOUT_MS: "200",
              PREVIEW_HANDOFF_TIMEOUT_MS: "100",
              PREVIEW_STARTUP_TIMEOUT_MS: "2000",
              PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
            },
            stdio: ["ignore", stdout, stderr],
          },
        );
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
      const output =
        readFileSync(stdoutPath, "utf8") + readFileSync(stderrPath, "utf8");

      assert.notEqual(result.status, 0, output);
      const record = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.doesNotThrow(() => validateHandoffPreflightRecord(record));
      assert.equal(
        record.boundaries.publicManifestReachability.status,
        "PASS",
      );
      assert.equal(record.boundaries.localHandoffProbe.status, "FAIL");
      assert.equal(record.boundaries.expoGoLaunch.status, "NOT_ASSESSED");
      assert.equal(
        record.boundaries.serverNativeRequestEvidence.status,
        "NOT_ASSESSED",
      );
      assert.equal(
        record.boundaries.localHandoffProbe.evidence,
        "Local manifest/bundle probe failed — no successful probe result was recorded",
      );
      assert.match(output, /public_manifest_reachability=PASS/);
      assert.match(output, /local_handoff_probe=FAIL/);
      assert.match(
        output,
        /Restart or repair the managed Chat App\/Expo workflow/,
      );
      assert.doesNotMatch(
        output,
        /127\.0\.0\.1|public-preview\.test|private-path|private-secret|token=|_expo\/static\/js\/bundle/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "aborts a stalled local manifest request at its deadline with recovery guidance",
  { timeout: 1_000 },
  async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        );
      });
    };

    try {
      await assert.rejects(
        requestLocalHandoffProbe(4_321, 25),
        (error) => {
          assert.match(error.message, /manifest request did not complete/);
          assert.match(error.message, /aborted by deadline/i);
          assert.match(
            error.message,
            /Restart or repair the managed Chat App\/Expo workflow/,
          );
          return true;
        },
      );
      assert.equal(request.options.signal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "aborts a stalled local bundle request at its deadline with recovery guidance",
  { timeout: 1_000 },
  async () => {
    const originalFetch = globalThis.fetch;
    let request;
    let requestCount = 0;
    globalThis.fetch = async (url, options) => {
      requestCount += 1;
      request = { url, options };
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            launchAsset: {
              url: "https://preview.example.test/_expo/static/js/bundle",
            },
          }),
          { status: 200 },
        );
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        );
      });
    };

    try {
      await assert.rejects(
        requestLocalHandoffProbe(4_321, 25),
        (error) => {
          assert.match(error.message, /manifest HTTP 200/);
          assert.match(error.message, /bundle request did not complete/);
          assert.match(error.message, /aborted by deadline/i);
          assert.match(
            error.message,
            /Restart or repair the managed Chat App\/Expo workflow/,
          );
          return true;
        },
      );
      assert.equal(requestCount, 2);
      assert.equal(request.options.signal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "live Metro manifest timeout exits with the timed-out resource and recovery guidance",
  { timeout: 5_000 },
  () =>
    runLiveMetroTimeoutFixture(
      "handoff-server-stall-manifest",
      /manifest request did not complete/,
    ),
);

test(
  "live Metro bundle timeout exits with the timed-out resource and recovery guidance",
  { timeout: 5_000 },
  () =>
    runLiveMetroTimeoutFixture(
      "handoff-server-stall-bundle",
      /bundle request did not complete/,
    ),
);

test("reports missing public preview configuration before making a request", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {}),
      /Public Expo preview manifest URL is not configured.*REPLIT_EXPO_DEV_DOMAIN or PREVIEW_PUBLIC_URL/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("falls back to REPLIT_EXPO_DEV_DOMAIN when PREVIEW_PUBLIC_URL is null", () => {
  const url = getPublicPreviewManifestUrl({
    PREVIEW_PUBLIC_URL: null,
    REPLIT_EXPO_DEV_DOMAIN: "preview.example.test/expo",
  });

  assert.equal(String(url), "https://preview.example.test/expo/");
});

test("falls back to REPLIT_EXPO_DEV_DOMAIN when PREVIEW_PUBLIC_URL is undefined", () => {
  const url = getPublicPreviewManifestUrl({
    PREVIEW_PUBLIC_URL: undefined,
    REPLIT_EXPO_DEV_DOMAIN: "preview.example.test/expo",
  });

  assert.equal(String(url), "https://preview.example.test/expo/");
});

test("reports missing configuration when PREVIEW_PUBLIC_URL is empty", () => {
  assert.throws(
    () =>
      getPublicPreviewManifestUrl({
        PREVIEW_PUBLIC_URL: "",
        REPLIT_EXPO_DEV_DOMAIN: "preview.example.test/expo",
      }),
    /Public Expo preview manifest URL is not configured.*REPLIT_EXPO_DEV_DOMAIN or PREVIEW_PUBLIC_URL/,
  );
});

test("reports malformed fallback configuration from REPLIT_EXPO_DEV_DOMAIN for nullish PREVIEW_PUBLIC_URL", () => {
  for (const previewPublicUrl of [null, undefined]) {
    assert.throws(
      () =>
        getPublicPreviewManifestUrl({
          PREVIEW_PUBLIC_URL: previewPublicUrl,
          REPLIT_EXPO_DEV_DOMAIN: "https://[invalid",
        }),
      /Public Expo preview manifest URL configuration from REPLIT_EXPO_DEV_DOMAIN is invalid/,
    );
  }
});

test("rejects non-HTTPS public preview configuration before making a request", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {
        PREVIEW_PUBLIC_URL: "http://preview.example.test/expo",
      }),
      /Public Expo preview manifest URL must use HTTPS/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("rejects credential-bearing public preview configuration before making a request", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {
        PREVIEW_PUBLIC_URL: "https://user:password@preview.example.test/expo",
      }),
      /Public Expo preview manifest URL must not contain credentials/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("rejects malformed PREVIEW_PUBLIC_URL configuration before making a request", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {
        PREVIEW_PUBLIC_URL: "https://[invalid",
      }),
      /Public Expo preview manifest URL configuration from PREVIEW_PUBLIC_URL is invalid/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("rejects malformed REPLIT_EXPO_DEV_DOMAIN configuration before making a request", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {
        REPLIT_EXPO_DEV_DOMAIN: "https://[invalid",
      }),
      /Public Expo preview manifest URL configuration from REPLIT_EXPO_DEV_DOMAIN is invalid/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("CLI rejects malformed PREVIEW_PUBLIC_URL before making a public request", () => {
  runMalformedPreviewConfigurationCli(
    "PREVIEW_PUBLIC_URL",
    "https://[invalid",
  );
});

test("CLI rejects malformed REPLIT_EXPO_DEV_DOMAIN before making a public request", () => {
  runMalformedPreviewConfigurationCli(
    "REPLIT_EXPO_DEV_DOMAIN",
    "https://[invalid",
  );
});

test("reports the malformed higher-precedence preview setting when both are configured", async () => {
  const fetchMock = mockFetch(new Response("{}"));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, {
        PREVIEW_PUBLIC_URL: "https://[invalid",
        REPLIT_EXPO_DEV_DOMAIN: "preview.example.test",
      }),
      /Public Expo preview manifest URL configuration from PREVIEW_PUBLIC_URL is invalid/,
    );
    assert.equal(fetchMock.request, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("rejects malformed public manifests with actionable recovery guidance", async () => {
  const fetchMock = mockFetch(new Response("{not-json", { status: 200 }));

  try {
    await assert.rejects(
      requestPublicPreviewManifest(1_000, previewEnvironment),
      (error) => {
        assert.match(
          error.message,
          /Public Expo preview manifest check failed: public manifest HTTP 200/,
        );
        assert.match(
          error.message,
          /invalid JSON|Unexpected token|Expected property name/i,
        );
        assert.match(
          error.message,
          /Restart or repair the managed Chat App\/Expo workflow/,
        );
        return true;
      },
    );
  } finally {
    fetchMock.restore();
  }
});

test("preflight record keeps public and local probes separate from phone evidence", () => {
  const record = createHandoffPreflightRecord({
    publicManifest: {
      outcome: "public manifest HTTP 200 (128 bytes)",
    },
    localHandoff: {
      manifest: "manifest HTTP 200 (64 bytes)",
      bundle: "bundle HTTP 200 (4096 bytes)",
    },
  });

  assert.equal(record.schema, "android-preview-handoff-preflight/v1");
  assert.equal(record.platform, "android");
  assert.equal(record.boundaries.publicManifestReachability.status, "PASS");
  assert.equal(record.boundaries.localHandoffProbe.status, "PASS");
  assert.equal(record.boundaries.expoGoLaunch.status, "NOT_ASSESSED");
  assert.equal(
    record.boundaries.serverNativeRequestEvidence.status,
    "NOT_ASSESSED",
  );

  const output = formatHandoffPreflight(record);
  assert.match(output, /public_manifest_reachability=PASS/);
  assert.match(output, /local_handoff_probe=PASS/);
  assert.match(output, /expo_go_launch=NOT_ASSESSED/);
  assert.match(output, /server_native_request_evidence=NOT_ASSESSED/);
  assert.doesNotMatch(output, /https?:\/\/|qr|token|message/i);
});

test("iOS preflight records use iOS schema, labels, and phone placeholders", () => {
  const record = createHandoffPreflightRecord({
    platform: "ios",
    publicManifestFailed: true,
  });

  assert.equal(record.schema, "ios-preview-handoff-preflight/v1");
  assert.equal(record.platform, "ios");
  assert.match(record.boundaries.expoGoLaunch.evidence, /physical iPhone/);
  assert.match(
    record.boundaries.serverNativeRequestEvidence.evidence,
    /physical Expo Go session/,
  );
  assert.match(
    formatHandoffPreflight(record),
    /^iOS preview handoff preflight/m,
  );
});

test("writes and validates an iOS preflight record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ios-preview-preflight-"));
  const outputPath = join(directory, "ios-preview-preflight.json");
  const record = createHandoffPreflightRecord({
    platform: "ios",
    publicManifest: {
      outcome: "public manifest HTTP 200 (128 bytes)",
    },
    localHandoff: {
      manifest: "manifest HTTP 200 (64 bytes)",
      bundle: "bundle HTTP 200 (4096 bytes)",
    },
  });

  try {
    await writeHandoffPreflight(outputPath, record);
    const writtenRecord = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.doesNotThrow(() =>
      validateHandoffPreflightRecord(writtenRecord),
    );
    assert.equal(writtenRecord.platform, "ios");
    assert.match(
      writtenRecord.boundaries.expoGoLaunch.evidence,
      /physical iPhone/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public-edge failure does not become missing-phone evidence", () => {
  const record = createHandoffPreflightRecord({
    publicManifestFailed: true,
  });

  assert.equal(record.boundaries.publicManifestReachability.status, "FAIL");
  assert.equal(record.boundaries.localHandoffProbe.status, "NOT_RUN");
  assert.equal(record.boundaries.expoGoLaunch.status, "NOT_ASSESSED");
  assert.equal(
    record.boundaries.serverNativeRequestEvidence.status,
    "NOT_ASSESSED",
  );
});

test("validates the redacted JSON schema and every boundary status enum", () => {
  const record = createHandoffPreflightRecord({
    publicManifest: {
      outcome: "public manifest HTTP 200 (128 bytes)",
    },
    localHandoff: {
      manifest: "manifest HTTP 200 (64 bytes)",
      bundle: "bundle HTTP 200 (4096 bytes)",
    },
  });

  assert.doesNotThrow(() =>
    validateHandoffPreflightRecord(JSON.parse(JSON.stringify(record))),
  );

  for (const [boundary, status] of [
    ["publicManifestReachability", "BLOCKED"],
    ["localHandoffProbe", "BLOCKED"],
    ["expoGoLaunch", "PASS"],
    ["serverNativeRequestEvidence", "BLOCKED"],
  ]) {
    const invalid = structuredClone(record);
    invalid.boundaries[boundary].status = status;
    assert.throws(
      () => validateHandoffPreflightRecord(invalid),
      /invalid .* boundary|expected redacted schema/i,
    );
  }

  const extraField = structuredClone(record);
  extraField.boundaries.publicManifestReachability.url = "https://secret.example";
  assert.throws(
    () => validateHandoffPreflightRecord(extraField),
    /expected redacted schema|invalid .* boundary/i,
  );

  const impossibleLocalProbe = createHandoffPreflightRecord({
    localHandoff: {
      manifest: "manifest HTTP 200 (64 bytes)",
      bundle: "bundle HTTP 200 (4096 bytes)",
    },
  });
  assert.throws(
    () => validateHandoffPreflightRecord(impossibleLocalProbe),
    /cannot report a local probe without public reachability/,
  );
});

test("keeps public-edge, local-probe, and phone evidence boundaries distinct", () => {
  const publicFailure = createHandoffPreflightRecord({
    publicManifestFailed: true,
  });
  const localFailure = createHandoffPreflightRecord({
    publicManifest: {
      outcome: "public manifest HTTP 200 (128 bytes)",
    },
    localHandoffFailed: true,
  });

  assert.doesNotThrow(() => validateHandoffPreflightRecord(publicFailure));
  assert.equal(
    publicFailure.boundaries.publicManifestReachability.status,
    "FAIL",
  );
  assert.equal(publicFailure.boundaries.localHandoffProbe.status, "NOT_RUN");
  assert.equal(publicFailure.boundaries.expoGoLaunch.status, "NOT_ASSESSED");

  assert.doesNotThrow(() => validateHandoffPreflightRecord(localFailure));
  assert.equal(
    localFailure.boundaries.publicManifestReachability.status,
    "PASS",
  );
  assert.equal(localFailure.boundaries.localHandoffProbe.status, "FAIL");
  assert.equal(localFailure.boundaries.expoGoLaunch.status, "NOT_ASSESSED");
});

test("rejects sensitive or non-redacted evidence without echoing it", () => {
  const record = createHandoffPreflightRecord();
  for (const evidence of [
    "https://preview.example.test/manifest.json",
    "Authorization: Bearer secret-token",
    "qr_payload=secret",
    "account_email=person@example.test",
    "message_body=private message",
    "person@example.test",
    "credential-value-123",
    "preview.example.test/private/path",
    "private message",
  ]) {
    const invalid = structuredClone(record);
    invalid.boundaries.publicManifestReachability.evidence = evidence;
    assert.throws(
      () => validateHandoffPreflightRecord(invalid),
      (error) => {
        assert.match(error.message, /unsafe evidence/);
        assert.doesNotMatch(error.message, new RegExp(evidence, "i"));
        return true;
      },
    );
  }
});

test("rejects duplicate top-level, boundary, and status fields before schema validation", async () => {
  const record = createHandoffPreflightRecord();
  const publicBoundary = JSON.stringify(
    record.boundaries.publicManifestReachability,
  );
  const duplicateSources = [
    [
      "top-level",
      `{"schema":"${record.schema}","schema":"duplicate-top-level-sentinel","platform":"android","boundaries":${JSON.stringify(record.boundaries)}}`,
      "duplicate-top-level-sentinel",
    ],
    [
      "boundary",
      `{"schema":"${record.schema}","platform":"android","boundaries":{"publicManifestReachability":${publicBoundary},"publicManifestReachability":${publicBoundary},"localHandoffProbe":${JSON.stringify(record.boundaries.localHandoffProbe)},"expoGoLaunch":${JSON.stringify(record.boundaries.expoGoLaunch)},"serverNativeRequestEvidence":${JSON.stringify(record.boundaries.serverNativeRequestEvidence)}}}`,
      "duplicate-boundary-sentinel",
    ],
    [
      "status",
      `{"schema":"${record.schema}","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","status":"FAIL","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":${JSON.stringify(record.boundaries.localHandoffProbe)},"expoGoLaunch":${JSON.stringify(record.boundaries.expoGoLaunch)},"serverNativeRequestEvidence":${JSON.stringify(record.boundaries.serverNativeRequestEvidence)}}}`,
      "duplicate-status-sentinel",
    ],
    [
      "nested",
      `{"schema":"${record.schema}","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)","details":{"note":"safe","note":"duplicate-nested-sentinel"}},"localHandoffProbe":${JSON.stringify(record.boundaries.localHandoffProbe)},"expoGoLaunch":${JSON.stringify(record.boundaries.expoGoLaunch)},"serverNativeRequestEvidence":${JSON.stringify(record.boundaries.serverNativeRequestEvidence)}}}`,
      "duplicate-nested-sentinel",
    ],
  ];

  for (const [kind, source, sentinel] of duplicateSources) {
    const directory = mkdtempSync(join(tmpdir(), `duplicate-${kind}-`));
    const outputPath = join(directory, "android-preview-preflight.json");
    writeFileSync(outputPath, source);
    try {
      await assert.rejects(
        () => readAndValidateHandoffPreflight(outputPath),
        (error) => {
          assert.equal(
            error.message,
            "Preview handoff preflight JSON contains duplicate fields.",
          );
          assert.doesNotMatch(error.message, new RegExp(sentinel));
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("record output reports unwritable parent paths", async () => {
  const record = createHandoffPreflightRecord();

  await assert.rejects(
    () => writeHandoffPreflight("/dev/null/android-handoff.json", record),
    /ENOTDIR|EEXIST|not a directory/i,
  );
});
