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
    appendRequestEvidence = createEvidenceAppender((contents) => {
      if (!requestEvidenceFileAvailable) return false;
      try {
        fs.writeFileSync(evidencePath, contents, "utf8");
        return true;
      } catch (error) {
        requestEvidenceFileAvailable = false;
        console.warn(
          `[dev-request] Redacted evidence file became unavailable; ` +
            `continuing with console output (${error.code ?? "unknown error"}).`,
        );
        return false;
      }
    });
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
            appendRequestEvidence(evidence);
          }
        });
        return wrapped(req, res, next);
      };
    },
  };
}

module.exports = config;
