import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_REQUEST_EVIDENCE_LINES,
  REQUEST_EVIDENCE_TRUNCATION_NOTICE,
  classifyClient,
  createEvidenceAppender,
  formatRequestEvidence,
  resolveEvidencePath,
} from "../metro-request-evidence.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

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

test("keeps the newest evidence in a bounded rolling window", () => {
  assert.equal(MAX_REQUEST_EVIDENCE_LINES, 1_000);
  const retainedContents = [];
  const appendEvidence = createEvidenceAppender(
    (contents) => {
      retainedContents.push(contents);
      return true;
    },
    3,
  );
  const consoleLines = [];

  for (const line of ["request 1", "request 2", "request 3", "request 4"]) {
    consoleLines.push(line);
    appendEvidence(line);
  }

  assert.deepEqual(consoleLines, [
    "request 1",
    "request 2",
    "request 3",
    "request 4",
  ]);
  assert.deepEqual(retainedContents, [
    "request 1\n",
    "request 1\nrequest 2\n",
    "[dev-request] Evidence file truncated after 2 request lines; console output continues.\n" +
      "request 2\nrequest 3\n",
    "[dev-request] Evidence file truncated after 2 request lines; console output continues.\n" +
      "request 3\nrequest 4\n",
  ]);
  assert.equal(appendEvidence("request 5"), true);
  assert.equal(
    retainedContents.at(-1),
    "[dev-request] Evidence file truncated after 2 request lines; console output continues.\n" +
      "request 4\nrequest 5\n",
  );
  assert.equal(retainedContents.at(-1).trimEnd().split("\n").length, 3);
});

test("Metro middleware keeps console diagnostics unbounded and retains newest evidence", async () => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-app-metro-evidence-"),
  );
  const evidencePath = path.join(temporaryDirectory, "request-evidence.log");

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const { EventEmitter } = require("node:events");
          const {
            MAX_REQUEST_EVIDENCE_LINES,
          } = require("./metro-request-evidence.js");

          const diagnostics = [];
          const warnings = [];
          console.log = (...args) => diagnostics.push(args.join(" "));
          console.warn = (...args) => warnings.push(args.join(" "));

          const config = require("./metro.config.js");
          const metroMiddleware = (req, res, next) => {
            res.statusCode = 200;
            res.emit("finish");
            next?.();
          };
          const wrappedMiddleware = config.server.enhanceMiddleware(
            metroMiddleware,
            {},
          );
          const requestCount = MAX_REQUEST_EVIDENCE_LINES + 1;

          for (let index = 0; index < requestCount; index += 1) {
            const req = {
              method: "GET",
              url: "/index.bundle?request=" + index + "&secret=private-message",
              headers: {
                "expo-platform": "android",
                "user-agent":
                  "Expo/57.0.0 (Android); account=private@example.com",
              },
            };
            const res = new EventEmitter();
            res.statusCode = 200;
            wrappedMiddleware(req, res, () => {});
          }

          const evidencePath = process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE;
          const truncationMarker = "Evidence file truncated after";
          const checkFile = setInterval(() => {
            let retainedContent = "";
            try {
              retainedContent = fs.readFileSync(evidencePath, "utf8");
            } catch {
              return;
            }

            if (!retainedContent.includes(truncationMarker)) return;

            clearInterval(checkFile);
            process.stdout.end(
              JSON.stringify({
                diagnosticCount: diagnostics.length,
                firstDiagnostic: diagnostics[0],
                lastDiagnostic: diagnostics.at(-1),
                warnings,
              }),
              () => process.exit(0),
            );
          }, 5);

          setTimeout(() => {
            clearInterval(checkFile);
            process.stderr.write(
              "Timed out waiting for retained Metro evidence.",
            );
            process.exit(1);
          }, 10_000);
        `,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          EXPO_DEV_REQUEST_EVIDENCE_FILE: evidencePath,
          EXPO_DEV_REQUEST_LOG: "",
        },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const result = JSON.parse(stdout);
    const retainedContent = await fs.readFile(evidencePath, "utf8");
    const retainedLines = retainedContent.split("\n");
    const retainedRequestLines = retainedLines.slice(1, -1);

    assert.equal(result.warnings.length, 0);
    assert.equal(
      result.diagnosticCount,
      MAX_REQUEST_EVIDENCE_LINES + 1,
    );
    assert.match(
      result.firstDiagnostic,
      /^\[dev-request\].*platform=android client=Expo Go .*resource=bundle$/,
    );
    assert.match(
      result.lastDiagnostic,
      /^\[dev-request\].*platform=android client=Expo Go .*resource=bundle$/,
    );
    assert.equal(retainedLines[0], REQUEST_EVIDENCE_TRUNCATION_NOTICE);
    assert.equal(retainedLines.at(-1), "");
    assert.equal(
      retainedRequestLines.length,
      MAX_REQUEST_EVIDENCE_LINES - 1,
    );
    assert.ok(
      retainedRequestLines.every((line) =>
        /^\[dev-request\].*platform=android client=Expo Go .*resource=bundle$/.test(
          line,
        ),
      ),
    );
    assert.doesNotMatch(
      retainedContent,
      /private@example\.com|private-message/,
    );
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
