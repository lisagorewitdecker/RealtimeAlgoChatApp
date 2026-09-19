import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "save-android-preview-evidence.mjs",
);

function runScript(args, evidenceSource = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        EXPO_DEV_REQUEST_EVIDENCE_FILE: evidenceSource,
      },
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
  "[dev-request] 2026-09-16T12:00:00.000Z GET 200 12ms platform=android client=Expo Go user-agent=[redacted] resource=manifest",
  "[dev-request] 2026-09-16T12:00:01.000Z OPTIONS 204 1ms platform=android client=Expo Go user-agent=[redacted] resource=other",
  "[dev-request] 2026-09-16T12:00:02.000Z GET 200 34ms platform=ios client=Expo Go user-agent=[redacted] resource=bundle",
  "[dev-request] 2026-09-16T12:00:03.000Z GET 200 2ms platform=android client=browser user-agent=[redacted] resource=other",
  "[dev-request] Evidence file truncated after 999 request lines; console output continues.",
].join("\n");

test("uses the default source and creates an Android handoff directory", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "android-evidence-"),
  );
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const timestamp = "20990101T000010Z";
  const handoffDirectory = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    "android",
    timestamp,
  );
  await writeFile(sourcePath, `${sourceEvidence}\n`, "utf8");
  await rm(handoffDirectory, { recursive: true, force: true });

  try {
    const result = await runScript(["--timestamp", timestamp], sourcePath);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Saved filtered Android Expo Go evidence:/);
    assert.match(result.stdout, /Filtered native request lines: 1/);
    assert.equal(
      (await stat(path.join(handoffDirectory, "logs"))).isDirectory(),
      true,
    );

    const retained = await readFile(
      path.join(handoffDirectory, "logs", "metro-request-evidence.txt"),
      "utf8",
    );
    const native = await readFile(
      path.join(
        handoffDirectory,
        "logs",
        "native-android-request-evidence.txt",
      ),
      "utf8",
    );
    assert.equal(retained, `${sourceEvidence}\n`);
    assert.match(native, /platform=android client=Expo Go/);
    assert.doesNotMatch(native, /OPTIONS|ios|browser/);
    assert.doesNotMatch(
      `${retained}${native}`,
      /account|https?:|token|credential|message|secret/i,
    );
  } finally {
    await rm(handoffDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("accepts an explicit source and existing Android handoff directory", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "android-evidence-"),
  );
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const timestamp = "20990101T000011Z";
  const handoffDirectory = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    "android",
    timestamp,
  );
  await writeFile(
    sourcePath,
    "[dev-request] 2026-09-16T12:00:00.000Z GET 200 12ms platform=android client=Expo Go user-agent=[redacted] resource=bundle\n",
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
        path.join(
          handoffDirectory,
          "logs",
          "native-android-request-evidence.txt",
        ),
        "utf8",
      ),
      /resource=bundle/,
    );
  } finally {
    await rm(handoffDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails for missing or malformed source without echoing sensitive data", async () => {
  const missingSource = "/tmp/private-account-token-message.log";
  const missing = await runScript([
    "--source",
    missingSource,
    "--timestamp",
    "20990101T000012Z",
  ]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /retained Metro evidence source is missing/);
  assert.doesNotMatch(missing.stderr, /private-account-token-message/);

  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "android-evidence-"),
  );
  const sourcePath = path.join(fixtureRoot, "metro.log");
  const handoffDirectory = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    "android",
    "20990101T000013Z",
  );
  const rawSentinel =
    "https://preview.example.invalid/account=private/message=secret";
  await writeFile(sourcePath, `${sourceEvidence}\n${rawSentinel}\n`, "utf8");
  await rm(handoffDirectory, { recursive: true, force: true });

  try {
    const result = await runScript([
      "--source",
      sourcePath,
      "--timestamp",
      "20990101T000013Z",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /non-redacted or unsupported line/);
    assert.doesNotMatch(result.stderr, /preview\.example|private|secret/);
    await assert.rejects(
      stat(path.join(handoffDirectory, "logs", "metro-request-evidence.txt")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(handoffDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
