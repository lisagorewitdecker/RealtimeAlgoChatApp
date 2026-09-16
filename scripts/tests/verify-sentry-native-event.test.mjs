import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findReadableSourceMappedFrame,
  validateNativeSentryEvent,
  verifyNativeSentryEvent,
  verifyNativeSentryEvidence,
} from "../verify-sentry-native-event.mjs";

function eventFixture(overrides = {}) {
  return {
    eventID: "0123456789abcdef0123456789abcdef",
    release: { version: "chat-app@1.0.0+abc123" },
    dist: "42",
    tags: [
      { key: "mobile_sentry_probe", value: "run-1234-ios" },
      { key: "mobile_platform", value: "ios" },
      { key: "mobile_candidate_build_id", value: "build-ios" },
    ],
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              stacktrace: {
                frames: [
                  {
                    filename: "app:///index.ios.bundle",
                    function: "anonymous",
                    lineNo: 1,
                    colNo: 12345,
                    inApp: true,
                  },
                  {
                    filename: "artifacts/chat-app/lib/sentry.ts",
                    function: "createNativeSourceMapProbeError",
                    lineNo: 55,
                    colNo: 10,
                    inApp: true,
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

const expected = {
  platform: "ios",
  candidateBuildId: "build-ios",
  marker: "run-1234-ios",
  release: "chat-app@1.0.0+abc123",
  dist: "42",
};

test("accepts a candidate-bound event with a readable source frame", () => {
  const evidence = validateNativeSentryEvent(eventFixture(), expected);
  assert.equal(evidence.status, "PASS");
  assert.equal(
    evidence.readableFrame.filename,
    "artifacts/chat-app/lib/sentry.ts",
  );
});

test("rejects an event from a different release", () => {
  assert.throws(
    () =>
      validateNativeSentryEvent(
        eventFixture({ release: { version: "wrong-release" } }),
        expected,
      ),
    /release 'wrong-release'/,
  );
});

test("rejects a minified bundle frame without mapped source", () => {
  const event = eventFixture();
  event.entries[0].data.values[0].stacktrace.frames.splice(1);
  assert.equal(findReadableSourceMappedFrame(event), undefined);
  assert.throws(
    () => validateNativeSentryEvent(event, expected),
    /readable in-app source-mapped frame/,
  );
});

test("rejects a mapped frame that is not the controlled probe function", () => {
  const event = eventFixture();
  event.entries[0].data.values[0].stacktrace.frames[1].function =
    "someOtherMappedFunction";
  assert.throws(
    () => validateNativeSentryEvent(event, expected),
    /readable in-app source-mapped frame/,
  );
});

test("retries transient Sentry API failures", async () => {
  const responses = [
    new Response("temporarily unavailable", { status: 503 }),
    Response.json([{ eventID: "0123456789abcdef0123456789abcdef" }]),
    Response.json(eventFixture()),
  ];
  const fetchImpl = async () => responses.shift();

  const evidence = await verifyNativeSentryEvent({
    fetchImpl,
    apiBaseUrl: "https://sentry.example",
    token: "test-token",
    organization: "test-org",
    project: "test-project",
    expected,
    attempts: 2,
    intervalMs: 0,
  });

  assert.equal(evidence.status, "PASS");
  assert.equal(responses.length, 0);
});

test("rejects a non-HTTPS Sentry API base URL", async () => {
  await assert.rejects(
    () =>
      verifyNativeSentryEvent({
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
        apiBaseUrl: "http://sentry.example",
        token: "test-token",
        organization: "test-org",
        project: "test-project",
        expected,
        attempts: 1,
        intervalMs: 0,
      }),
    /SENTRY_API_BASE_URL must use HTTPS/,
  );
});

test("rejects a credentialed Sentry API base URL", async () => {
  await assert.rejects(
    () =>
      verifyNativeSentryEvent({
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
        apiBaseUrl: ["https://", "user:pass@sentry.example"].join(""),
        token: "test-token",
        organization: "test-org",
        project: "test-project",
        expected,
        attempts: 1,
        intervalMs: 0,
      }),
    /SENTRY_API_BASE_URL must not contain credentials/,
  );
});

test("rejects a Sentry API base URL with a path", async () => {
  await assert.rejects(
    () =>
      verifyNativeSentryEvent({
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
        apiBaseUrl: "https://sentry.example/proxy/",
        token: "test-token",
        organization: "test-org",
        project: "test-project",
        expected,
        attempts: 1,
        intervalMs: 0,
      }),
    /SENTRY_API_BASE_URL must not include a path/,
  );
});

test("normalizes a Sentry API base URL with only repeated root slashes", async () => {
  const capturedUrls = [];
  await assert.rejects(
    () =>
      verifyNativeSentryEvent({
        fetchImpl: async (url) => {
          capturedUrls.push(new URL(url));
          return Response.json([]);
        },
        apiBaseUrl: "https://sentry.example//",
        token: "test-token",
        organization: "test-org",
        project: "test-project",
        expected,
        attempts: 1,
        intervalMs: 0,
      }),
    /verification timeout/,
  );

  assert.equal(capturedUrls.length, 1);
  assert.equal(capturedUrls[0].pathname, "/api/0/projects/test-org/test-project/events/");
});

test("quotes Sentry search values before requesting events", async () => {
  const capturedUrls = [];
  await assert.rejects(
    () =>
      verifyNativeSentryEvent({
        fetchImpl: async (url) => {
          capturedUrls.push(new URL(url));
          return Response.json([]);
        },
        apiBaseUrl: "https://sentry.example?ignored=yes#hash",
        token: "test-token",
        organization: "test-org",
        project: "test-project",
        expected: {
          ...expected,
          marker: 'run 1234 "ios"',
        },
        attempts: 1,
        intervalMs: 0,
      }),
    /verification timeout/,
  );

  assert.equal(capturedUrls.length, 1);
  assert.equal(
    capturedUrls[0].searchParams.get("query"),
    String.raw`release:"chat-app@1.0.0+abc123" mobile_sentry_probe:"run 1234 \"ios\"" mobile_platform:"ios"`,
  );
  assert.equal(capturedUrls[0].searchParams.get("ignored"), null);
  assert.equal(capturedUrls[0].hash, "");
});


test("accepts a redacted saved evidence file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-evidence-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");

  await writeFile(
    evidencePath,
    `${JSON.stringify(validateNativeSentryEvent(eventFixture(), expected))}\n`,
  );
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      "marker=run-1234-ios",
    ].join("\n"),
  );

  const evidence = verifyNativeSentryEvidence({
    evidencePath,
    triggerPath,
    expectedPlatform: expected.platform,
    expectedBuildId: expected.candidateBuildId,
    expectedProbeMarker: expected.marker,
    expectedRelease: expected.release,
    expectedDist: expected.dist,
  });

  assert.equal(evidence.eventId, "0123456789abcdef0123456789abcdef");
});

test("rejects duplicate trigger metadata fields", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-trigger-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");

  await writeFile(
    evidencePath,
    `${JSON.stringify(validateNativeSentryEvent(eventFixture(), expected))}\n`,
  );
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      "marker=run-1234-ios",
      "marker=attacker-controlled",
    ].join("\n"),
  );

  assert.throws(
    () =>
      verifyNativeSentryEvidence({
        evidencePath,
        triggerPath,
        expectedPlatform: expected.platform,
        expectedBuildId: expected.candidateBuildId,
      }),
    /trigger metadata contains duplicate field\(s\)/,
  );
});

test("accepts trigger metadata values containing '='", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-trigger-marker-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");
  const expectedWithEquals = {
    ...expected,
    marker: "run-1234=ios",
  };

  await writeFile(
    evidencePath,
    `${JSON.stringify(
      validateNativeSentryEvent(
        eventFixture({
          tags: [
            { key: "mobile_sentry_probe", value: expectedWithEquals.marker },
            { key: "mobile_platform", value: expected.platform },
            {
              key: "mobile_candidate_build_id",
              value: expected.candidateBuildId,
            },
          ],
        }),
        expectedWithEquals,
      ),
    )}\n`,
  );
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      `marker=${expectedWithEquals.marker}`,
    ].join("\n"),
  );

  const evidence = verifyNativeSentryEvidence({
    evidencePath,
    triggerPath,
    expectedPlatform: expected.platform,
    expectedBuildId: expected.candidateBuildId,
    expectedProbeMarker: expectedWithEquals.marker,
    expectedRelease: expected.release,
    expectedDist: expected.dist,
  });

  assert.equal(evidence.marker, expectedWithEquals.marker);
});

test("rejects trigger metadata with missing required fields", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-trigger-missing-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");

  await writeFile(
    evidencePath,
    `${JSON.stringify(validateNativeSentryEvent(eventFixture(), expected))}\n`,
  );
  await writeFile(
    triggerPath,
    ["platform=ios", "candidate_build_id=build-ios"].join("\n"),
  );

  assert.throws(
    () =>
      verifyNativeSentryEvidence({
        evidencePath,
        triggerPath,
        expectedPlatform: expected.platform,
        expectedBuildId: expected.candidateBuildId,
      }),
    /trigger metadata is malformed/,
  );
});

test("allows non-credential authorization text in saved evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-evidence-authorization-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");
  const evidenceRecord = validateNativeSentryEvent(eventFixture(), expected);

  await writeFile(
    evidencePath,
    `${JSON.stringify({ ...evidenceRecord, authorization: "reviewed" })}\n`,
  );
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      "marker=run-1234-ios",
    ].join("\n"),
  );

  const verified = verifyNativeSentryEvidence({
    evidencePath,
    triggerPath,
    expectedPlatform: expected.platform,
    expectedBuildId: expected.candidateBuildId,
    expectedProbeMarker: expected.marker,
    expectedRelease: expected.release,
    expectedDist: expected.dist,
  });

  assert.equal(verified.eventId, evidenceRecord.eventId);
});

test("rejects nested credential-bearing evidence fields", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-evidence-secret-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");
  const evidenceRecord = validateNativeSentryEvent(eventFixture(), expected);

  await writeFile(
    evidencePath,
    `${JSON.stringify({
      ...evidenceRecord,
      request: {
        headers: {
          authorization_token: "secret-value",
        },
      },
    })}\n`,
  );
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      "marker=run-1234-ios",
    ].join("\n"),
  );

  assert.throws(
    () =>
      verifyNativeSentryEvidence({
        evidencePath,
        triggerPath,
        expectedPlatform: expected.platform,
        expectedBuildId: expected.candidateBuildId,
        expectedProbeMarker: expected.marker,
        expectedRelease: expected.release,
        expectedDist: expected.dist,
      }),
    /evidence contains credential-like content/,
  );
});

test("rejects non-object saved evidence JSON", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sentry-evidence-primitive-"));
  const evidencePath = path.join(tempDir, "sentry-source-map-evidence.json");
  const triggerPath = path.join(tempDir, "sentry-trigger.txt");

  await writeFile(evidencePath, '"not-an-object"\n');
  await writeFile(
    triggerPath,
    [
      "platform=ios",
      "candidate_build_id=build-ios",
      "marker=run-1234-ios",
    ].join("\n"),
  );

  assert.throws(
    () =>
      verifyNativeSentryEvidence({
        evidencePath,
        triggerPath,
        expectedPlatform: expected.platform,
        expectedBuildId: expected.candidateBuildId,
      }),
    /evidence must be a JSON object/,
  );
});
