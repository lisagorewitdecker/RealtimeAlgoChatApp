import assert from "node:assert/strict";
import test from "node:test";

import {
  findReadableSourceMappedFrame,
  validateNativeSentryEvent,
  verifyNativeSentryEvent,
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