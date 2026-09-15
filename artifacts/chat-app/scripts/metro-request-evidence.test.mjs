import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  classifyClient,
  formatRequestEvidence,
  resolveEvidencePath,
} from "../metro-request-evidence.js";

function request(userAgent, platform = "android", url = "/index.bundle") {
  return {
    method: "GET",
    url,
    headers: {
      "expo-platform": platform,
      "user-agent": userAgent,
    },
  };
}

test("keeps synthetic preview validation separate from physical Expo Go", () => {
  assert.equal(
    classifyClient(request("Expo/57.0.0 (preview-validation)")),
    "preview-validation",
  );
  assert.equal(classifyClient(request("Expo/57.0.0 (Android)")), "Expo Go");
});

test("distinguishes browser and curl probes", () => {
  assert.equal(classifyClient(request("Mozilla/5.0")), "browser");
  assert.equal(classifyClient(request("curl/8.14.1")), "curl");
});

test("redacts request details while retaining the native marker", () => {
  const evidence = formatRequestEvidence(
    request(
      "Expo/57.0.0 (Android); account=private@example.com",
      "android",
      "/index.bundle?token=secret-message",
    ),
    { statusCode: 200 },
    1_000,
    1_250,
  );

  assert.match(
    evidence,
    /platform=android client=Expo Go user-agent=\[redacted\] resource=bundle/,
  );
  assert.doesNotMatch(
    evidence,
    /private\.example\.com|secret-message|private@example\.com|Expo\/57\.0\.0/,
  );
});

test("resolves relative evidence paths from the Chat App package root", () => {
  const packageRoot = "/workspace/artifacts/chat-app";
  assert.equal(
    resolveEvidencePath(
      "test-results/encrypted-room-recovery/android/run/logs/metro.txt",
      packageRoot,
    ),
    path.join(
      packageRoot,
      "test-results/encrypted-room-recovery/android/run/logs/metro.txt",
    ),
  );
});