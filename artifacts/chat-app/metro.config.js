const { getSentryExpoConfig } = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

// Opt-in request log for debugging phones that cannot load the development
// preview. Prints one line per request that reaches Metro (bundles, assets,
// lazy route bundles) with the host and client the phone used, without
// touching bodies or auth headers. Enable with EXPO_DEV_REQUEST_LOG=1.
if (process.env.EXPO_DEV_REQUEST_LOG === "1") {
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
          const url = String(req.url ?? "").slice(0, 140);
          console.log(
            `[dev-request] ${new Date().toISOString()} ${req.method} ${res.statusCode} ` +
              `${Date.now() - startedAt}ms host=${req.headers.host ?? "-"} ` +
              `platform=${req.headers["expo-platform"] ?? "-"} ` +
              `ua=${String(req.headers["user-agent"] ?? "-").slice(0, 60)} ${url}`,
          );
        });
        return wrapped(req, res, next);
      };
    },
  };
}

module.exports = config;
