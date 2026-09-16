import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "save-ios-preview-evidence.mjs",
);

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, EXPO_DEV_REQUEST_EVIDENCE_FILE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

const sourceEvidence = [
  "[dev-request] 2026-09-16T12:00:00.000Z GET 200 12ms platform=ios client=Expo Go user-agent=[redacted] resource=manifest",
  "[dev-request] 2026-09-16T12:00:01.000Z OPTIONS 204 1ms platform=ios client=Expo Go user-agent=[redacted] resource=other",
  "[dev-request] 2026-09-16T12:00:02.000Z GET 200 34ms platform=android client=Expo Go user-agent=[redacted] resource=bundle",
  "[dev-request] 2026-09-16T12:00:03.000Z GET 200 2ms platform=ios client=browser user-agent=[redacted] resource=other",
  "[dev-request] Evidence file truncated after 999 request lines; console output continues.",
].join("\n");

test("creates an iOS handoff directory and writes only safe native lines", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ios-evidence-"));
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const timestamp = "20990101T000000Z";
  const handoffDirectory = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    "ios",
    timestamp,
  );

  await writeFile(sourcePath, `${sourceEvidence}\n`, "utf8");
  await rm(handoffDirectory, { recursive: true, force: true });

  try {
    const result = await runScript([
      "--source",
      sourcePath,
      "--timestamp",
      timestamp,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Saved filtered iOS Expo Go evidence:/);
    assert.match(result.stdout, /Filtered native request lines: 1/);

    const retained = await readFile(
      path.join(handoffDirectory, "logs", "metro-request-evidence.txt"),
      "utf8",
    );
    const native = await readFile(
      path.join(handoffDirectory, "logs", "native-ios-request-evidence.txt"),
      "utf8",
    );
    assert.equal(retained, `${sourceEvidence}\n`);
    assert.match(native, /platform=ios client=Expo Go/);
    assert.doesNotMatch(native, /OPTIONS|android|browser/);
    assert.doesNotMatch(
      `${retained}${native}`,
      /account|https?:|token|credential|message|secret/i,
    );
  } finally {
    await rm(handoffDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("accepts an existing validated handoff directory", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ios-evidence-"));
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const timestamp = "20990101T000001Z";
  const handoffDirectory = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    "ios",
    timestamp,
  );
  await writeFile(
    sourcePath,
    "[dev-request] 2026-09-16T12:00:00.000Z GET 200 12ms platform=ios client=Expo Go user-agent=[redacted] resource=bundle\n",
    "utf8",
  );
  await rm(handoffDirectory, { recursive: true, force: true });

  try {
    const result = await runScript([
      "--source",
      sourcePath,
      "--handoff-dir",
      path.relative(PACKAGE_ROOT, handoffDirectory),
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Filtered native request lines: 1/);
    assert.match(
      await readFile(
        path.join(handoffDirectory, "logs", "native-ios-request-evidence.txt"),
        "utf8",
      ),
      /resource=bundle/,
    );
  } finally {
    await rm(handoffDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("accepts the package-manager argument separator", async () => {
  const result = await runScript(["--", "--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Save redacted iOS Expo Go preview request evidence/);
});

test("fails clearly for a missing source without echoing its path", async () => {
  const missingSource = "/tmp/private-account-token-message.log";
  const result = await runScript([
    "--source",
    missingSource,
    "--timestamp",
    "20990101T000002Z",
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /retained Metro evidence source is missing/);
  assert.doesNotMatch(result.stderr, /private-account-token-message/);
});

test("refuses a source line that is not in the redacted Metro contract", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ios-evidence-"));
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const rawSentinel =
    "https://preview.example.invalid/account=private/message=secret";
  await writeFile(
    sourcePath,
    `${sourceEvidence}\n${rawSentinel}\n`,
    "utf8",
  );

  try {
    const result = await runScript([
      "--source",
      sourcePath,
      "--timestamp",
      "20990101T000003Z",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /non-redacted or unsupported line/);
    assert.doesNotMatch(result.stderr, /preview\.example|private|secret/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});