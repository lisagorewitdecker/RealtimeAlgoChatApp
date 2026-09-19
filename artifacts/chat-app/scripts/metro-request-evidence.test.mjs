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

const sensitiveEvidenceMarkers = [
  "preview-user",
  "preview-password",
  "private.example.com",
  "secret-query-token",
  "private@example.com",
  "private-message",
  "Expo/57.0.0 (Android); account=private@example.com",
  "Mozilla/5.0 (private-browser)",
  "curl/8.14.1 (private-curl)",
  "UnknownPreview/1.0 (private-unknown)",
];

function assertContainsNoSensitiveEvidence(contents) {
  for (const marker of sensitiveEvidenceMarkers) {
    assert.doesNotMatch(
      contents,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `private marker leaked into evidence: ${marker}`,
    );
  }
}

test("keeps synthetic preview validation separate from physical Expo Go", () => {
  assert.equal(
    classifyClient(request("Expo/57.0.0 (preview-validation)")),
    "preview-validation",
  );
  assert.equal(classifyClient(request("Expo/57.0.0 (Android)")), "Expo Go");
});

test("starts a fresh retained evidence file for each Metro process", async () => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-app-metro-fresh-start-"),
  );
  const evidencePath = path.join(temporaryDirectory, "request-evidence.log");
  const oldRunMarker = "[dev-request] old Metro run must not be retained";

  try {
    await fs.writeFile(evidencePath, `${oldRunMarker}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const { EventEmitter } = require("node:events");

          const warnings = [];
          console.log = () => {};
          console.warn = (...args) => warnings.push(args.join(" "));

          const config = require("./metro.config.js");
          const evidencePath = process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE;
          const startupContents = fs.readFileSync(evidencePath, "utf8");
          const metroMiddleware = (req, res, next) => {
            res.statusCode = 200;
            res.emit("finish");
            next?.();
          };
          const wrappedMiddleware = config.server.enhanceMiddleware(
            metroMiddleware,
            {},
          );
          const req = {
            method: "GET",
            url:
              "https://preview-user:preview-password@private.example.com/" +
              "manifest.json?token=secret-query-token",
            headers: {
              "expo-platform": "ios",
              "user-agent":
                "Expo/57.0.0 (iOS); account=private@example.com",
            },
          };
          const res = new EventEmitter();
          res.statusCode = 200;
          wrappedMiddleware(req, res, () => {});

          const checkFile = setInterval(() => {
            let fileContents = "";
            try {
              fileContents = fs.readFileSync(evidencePath, "utf8");
            } catch {
              return;
            }

            if (!fileContents.includes("resource=manifest")) return;

            clearInterval(checkFile);
            process.stdout.end(
              JSON.stringify({ fileContents, startupContents, warnings }),
              () => process.exit(0),
            );
          }, 5);

          setTimeout(() => {
            clearInterval(checkFile);
            process.stderr.write(
              "Timed out waiting for fresh retained Metro evidence.",
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

    assert.deepEqual(result.warnings, []);
    assert.equal(result.startupContents, "");
    assert.equal(result.fileContents, retainedContent);
    assert.doesNotMatch(retainedContent, /old Metro run/);
    assert.doesNotMatch(
      retainedContent,
      /private\.example\.com|private@example\.com|secret-query-token/,
    );
    assert.match(
      retainedContent,
      /^\[dev-request\] \S+ GET 200 \d+ms platform=ios client=Expo Go user-agent=\[redacted\] resource=manifest\n$/,
    );
    assert.equal(retainedContent.trimEnd().split("\n").length, 1);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("distinguishes browser and curl probes", () => {
  assert.equal(classifyClient(request("Mozilla/5.0")), "browser");
  assert.equal(classifyClient(request("curl/8.14.1")), "curl");
  assert.equal(classifyClient(request("UnknownPreview/1.0")), "other");
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
  assertContainsNoSensitiveEvidence(evidence);
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

test("keeps every client marker while redacting console and file evidence", async () => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-app-metro-privacy-"),
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
          const requests = [
            {
              url:
                "https://preview-user:preview-password@private.example.com/" +
                "index.bundle?token=secret-query-token&message=private-message",
              userAgent:
                "Expo/57.0.0 (Android); account=private@example.com",
            },
            {
              url:
                "https://private.example.com/manifest.json?" +
                "account=private@example.com",
              userAgent: "Mozilla/5.0 (private-browser)",
              extraHeaders: { "sec-fetch-mode": "cors" },
            },
            {
              url:
                "https://private.example.com/assets/logo.png?" +
                "message=private-message",
              userAgent: "curl/8.14.1 (private-curl)",
            },
            {
              url:
                "https://private.example.com/room/private-message?" +
                "token=secret-query-token",
              userAgent: "UnknownPreview/1.0 (private-unknown)",
            },
          ];

          for (const { url, userAgent, extraHeaders } of requests) {
            const req = {
              method: "GET",
              url,
              headers: {
                "expo-platform": "android",
                "user-agent": userAgent,
                ...extraHeaders,
              },
            };
            const res = new EventEmitter();
            res.statusCode = 200;
            wrappedMiddleware(req, res, () => {});
          }

          process.stdout.write(
            JSON.stringify({
              diagnostics,
              warnings,
              fileContents: fs.readFileSync(
                process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE,
                "utf8",
              ),
            }),
          );
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
    const consoleContent = result.diagnostics.join("\n");

    assert.deepEqual(
      result.diagnostics.map((line) => {
        const match = line.match(/client=(Expo Go|browser|curl|other)/);
        return match?.[1];
      }),
      ["Expo Go", "browser", "curl", "other"],
    );
    assert.deepEqual(
      result.diagnostics.map((line) => {
        const match = line.match(/resource=([^ ]+)$/);
        return match?.[1];
      }),
      ["bundle", "manifest", "asset", "other"],
    );
    assert.equal(result.warnings.length, 0);
    assertContainsNoSensitiveEvidence(consoleContent);
    assertContainsNoSensitiveEvidence(result.fileContents);
    assertContainsNoSensitiveEvidence(retainedContent);
    assert.match(
      consoleContent,
      /user-agent=\[redacted\].*resource=bundle/,
    );
    assert.match(
      retainedContent,
      /user-agent=\[redacted\].*resource=other/,
    );
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("keeps the newest evidence in a bounded rolling window", async () => {
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
    await appendEvidence(line);
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
  assert.equal(await appendEvidence("request 5"), true);
  assert.equal(
    retainedContents.at(-1),
    "[dev-request] Evidence file truncated after 2 request lines; console output continues.\n" +
      "request 4\nrequest 5\n",
  );
  assert.equal(retainedContents.at(-1).trimEnd().split("\n").length, 3);
});

test("serializes asynchronous evidence writes in request order", async () => {
  const writes = [];
  const writeStarted = [];
  const releaseWrite = [];
  const appendEvidence = createEvidenceAppender(
    (contents) => {
      writes.push(contents);
      const started = new Promise((resolve) => {
        writeStarted.push(resolve);
      });
      const released = new Promise((resolve) => {
        releaseWrite.push(resolve);
      });
      return started.then(() => released);
    },
    4,
  );

  const firstWrite = appendEvidence("request 1");
  const secondWrite = appendEvidence("request 2");
  await Promise.resolve();
  writeStarted[0]();
  await Promise.resolve();

  assert.deepEqual(writes, ["request 1\n"]);
  releaseWrite[0]();
  await firstWrite;
  await Promise.resolve();
  assert.deepEqual(writes, ["request 1\n", "request 1\nrequest 2\n"]);

  writeStarted[1]();
  releaseWrite[1]();
  assert.equal(await secondWrite, true);
});

test("disables persistence after a write failure while later appends resolve", async () => {
  const writes = [];
  const failures = [];
  const appendEvidence = createEvidenceAppender(
    () => {
      writes.push(true);
      return Promise.reject(
        Object.assign(new Error("disk full"), { code: "ENOSPC" }),
      );
    },
    3,
    (error) => failures.push(error),
  );

  assert.equal(await appendEvidence("request 1"), false);
  assert.equal(await appendEvidence("request 2"), false);
  assert.equal(await appendEvidence("request 3"), false);
  assert.equal(writes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "ENOSPC");
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
