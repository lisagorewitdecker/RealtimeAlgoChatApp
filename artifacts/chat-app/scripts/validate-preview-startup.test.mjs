import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
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
  createHandoffPreflightRecord,
  formatHandoffPreflight,
  getPublicPreviewManifestUrl,
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
    await requestPublicPreviewManifest(1_000, previewEnvironment, "ios");

    assert.equal(fetchMock.request.options.headers["expo-platform"], "ios");
  } finally {
    fetchMock.restore();
  }
});

test("local iOS handoff probe requests both manifest and bundle with the iOS header", async () => {
  const observedPlatforms = [];
  const server = createServer((request, response) => {
    observedPlatforms.push(request.headers["expo-platform"]);
    response.setHeader("content-type", "application/json");
    if (request.url === "/") {
      response.end(
        JSON.stringify({
          launchAsset: {
            url: "https://preview.example.test/_expo/static/js/ios-bundle",
          },
        }),
      );
      return;
    }
    response.setHeader("content-type", "application/javascript");
    response.end("console.log('ios');");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");

  try {
    const result = await requestLocalHandoffProbe(address.port, 1_000, "ios");
    assert.match(result.manifest, /^manifest HTTP 200/);
    assert.match(result.bundle, /^bundle HTTP 200/);
    assert.deepEqual(observedPlatforms, ["ios", "ios"]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
