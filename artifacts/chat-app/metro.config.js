/* jshint esversion: 6 */

const fs = require("node:fs");
const path = require("node:path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const {
  createEvidenceAppender,
  formatRequestEvidence,
  resolveEvidencePath,
} = require("./metro-request-evidence");

const config = getSentryExpoConfig(__dirname);

// Opt-in request log for debugging phones that cannot load the development
// preview. The log is deliberately redacted: it includes only request
// metadata and coarse client/resource classifications, never a host, URL,
// query string, or raw user-agent. Enable with EXPO_DEV_REQUEST_LOG=1 to write
// the default file at .expo/dev-request-evidence.log, or set
// EXPO_DEV_REQUEST_EVIDENCE_FILE to enable it and write to a handoff path
// relative to the Chat App package root.
const requestLogEnabled =
  process.env.EXPO_DEV_REQUEST_LOG === "1" ||
  Boolean(process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE);

let appendRequestEvidence;
if (requestLogEnabled) {
  const configuredEvidencePath = process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE;
  const evidencePath = resolveEvidencePath(configuredEvidencePath, __dirname);
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, "", "utf8");
    let requestEvidenceFileAvailable = true;
    appendRequestEvidence = createEvidenceAppender(
      async (contents) => {
        if (!requestEvidenceFileAvailable) return false;
        // External readers poll this file while writes are queued behind it.
        // Write a sibling temp file and rename it into place so a reader can
        // never observe the truncate-then-rewrite window as an empty or
        // partial evidence file.
        const temporaryPath = `${evidencePath}.tmp`;
        await fs.promises.writeFile(temporaryPath, contents, "utf8");
        await fs.promises.rename(temporaryPath, evidencePath);
      },
      undefined,
      (error) => {
        requestEvidenceFileAvailable = false;
        console.warn(
          `[dev-request] Redacted evidence file became unavailable; ` +
            `continuing with console output (${error.code ?? "unknown error"}).`,
        );
      },
    );
  } catch (error) {
    console.warn(
      `[dev-request] Could not open the redacted evidence file; ` +
        `continuing with console output (${error.code ?? "unknown error"}).`,
    );
  }
}

if (requestLogEnabled) {
  const previousEnhance = config.server?.enhanceMiddleware;
  config.server = {
    ...config.server,
    enhanceMiddleware: (metroMiddleware, server) => {
      const wrapped = previousEnhance
        ? previousEnhance(metroMiddleware, server)
        : metroMiddleware;
      return (req, res, next) => {
        const startedAt = Date.now();
        res.once("finish", () => {
          const evidence = formatRequestEvidence(req, res, startedAt);
          console.log(evidence);
          if (appendRequestEvidence) {
            // File persistence is deliberately queued and must not delay Metro.
            void appendRequestEvidence(evidence);
          }
        });
        return wrapped(req, res, next);
      };
    },
  };
}

module.exports = config;
