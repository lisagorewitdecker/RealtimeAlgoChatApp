/* jshint esversion: 11 */
/* jshint esversion: 6 */

const path = require("node:path");

const MAX_REQUEST_EVIDENCE_LINES = 1_000;
const REQUEST_EVIDENCE_TRUNCATION_NOTICE =
  `[dev-request] Evidence file truncated after ` +
  `${MAX_REQUEST_EVIDENCE_LINES - 1} request lines; console output continues.`;

function classifyClient(request) {
  const userAgent = String(request.headers["user-agent"] ?? "").toLowerCase();
  if (userAgent.includes("preview-validation")) return "preview-validation";
  if (/\bexpo(?:\s+go)?(?:\/|\s|$)/.test(userAgent)) return "Expo Go";
  if (/\b(?:curl|wget)(?:\/|\s|$)/.test(userAgent)) return "curl";
  if (
    request.method === "OPTIONS" ||
    userAgent.includes("mozilla/") ||
    request.headers["sec-fetch-mode"] ||
    request.headers["sec-fetch-site"]
  ) {
    return "browser";
  }
  return "other";
}

function normalizePlatform(request) {
  const platform = String(request.headers["expo-platform"] ?? "").toLowerCase();
  return platform === "android" || platform === "ios" || platform === "web"
    ? platform
    : "-";
}

function classifyResource(request) {
  const requestPath = String(request.url ?? "").split("?", 1)[0].toLowerCase();
  if (requestPath.endsWith("/manifest") || requestPath.endsWith("/manifest.json")) {
    return "manifest";
  }
  if (requestPath.includes("bundle") || requestPath.endsWith(".js")) {
    return "bundle";
  }
  if (
    requestPath.includes("asset") ||
    requestPath.match(/\.(png|jpg|jpeg|webp|ttf|otf)$/)
  ) {
    return "asset";
  }
  return "other";
}

function formatRequestEvidence(request, response, startedAt, now = Date.now()) {
  return (
    `[dev-request] ${new Date(now).toISOString()} ${request.method} ` +
    `${response.statusCode} ${now - startedAt}ms ` +
    `platform=${normalizePlatform(request)} client=${classifyClient(request)} ` +
    "user-agent=[redacted] " +
    `resource=${classifyResource(request)}`
  );
}

function resolveEvidencePath(configuredPath, packageRoot) {
  return configuredPath
    ? path.resolve(packageRoot, configuredPath)
    : path.join(packageRoot, ".expo", "dev-request-evidence.log");
}

function createEvidenceAppender(writeContents, maxLines = MAX_REQUEST_EVIDENCE_LINES) {
  if (!Number.isInteger(maxLines) || maxLines < 2) {
    throw new RangeError("maxLines must be an integer greater than one");
  }

  const retainedRequestLines = [];
  let truncated = false;
  const truncationNotice =
    maxLines === MAX_REQUEST_EVIDENCE_LINES
      ? REQUEST_EVIDENCE_TRUNCATION_NOTICE
      : `[dev-request] Evidence file truncated after ${
          maxLines - 1
        } request lines; console output continues.`;

  return (evidence) => {
    if (retainedRequestLines.length === maxLines - 1) {
      truncated = true;
    }

    retainedRequestLines.push(evidence);
    if (retainedRequestLines.length > maxLines - 1) {
      retainedRequestLines.shift();
    }

    const contents =
      (truncated ? `${truncationNotice}\n` : "") +
      retainedRequestLines.map((line) => `${line}\n`).join("");
    if (!writeContents(contents)) return false;

    return true;
  };
}

module.exports = {
  MAX_REQUEST_EVIDENCE_LINES,
  REQUEST_EVIDENCE_TRUNCATION_NOTICE,
  classifyClient,
  classifyResource,
  createEvidenceAppender,
  formatRequestEvidence,
  normalizePlatform,
  resolveEvidencePath,
};