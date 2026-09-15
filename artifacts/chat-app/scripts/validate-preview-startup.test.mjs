import assert from "node:assert/strict";
import test from "node:test";

import {
  createHandoffPreflightRecord,
  formatHandoffPreflight,
  requestPublicPreviewManifest,
  writeHandoffPreflight,
} from "./validate-preview-startup.mjs";

const previewEnvironment = {
  PREVIEW_PUBLIC_URL: "https://preview.example.test/expo",
};

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

test("record output reports unwritable parent paths", async () => {
  const record = createHandoffPreflightRecord();

  await assert.rejects(
    () => writeHandoffPreflight("/dev/null/android-handoff.json", record),
    /ENOTDIR|EEXIST|not a directory/i,
  );
});
