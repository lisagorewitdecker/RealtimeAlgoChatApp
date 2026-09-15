const path = require("node:path");

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

module.exports = {
  classifyClient,
  classifyResource,
  formatRequestEvidence,
  normalizePlatform,
  resolveEvidencePath,
};