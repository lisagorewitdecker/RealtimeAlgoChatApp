import { isMainThread } from "node:worker_threads";

// Node workers inherit --import through execArgv, so this module is evaluated
// again inside every pino transport worker. Nothing may run off the main
// thread: a static logger import here would build another transport-backed
// logger in each worker, which spawns another transport worker, which
// evaluates this module again — an unbounded chain of threads that grows until
// the process is killed. The logger is therefore loaded only after the check.
//
// Sentry is loaded lazily for a related reason. Its module graph is the single
// largest piece of startup work, and a static import would make every
// transport worker pay for it as well. Production cold starts run on a small
// autoscale machine that has to answer the platform health check within a few
// seconds, so this preload must stay cheap on every thread but the main one.
if (isMainThread) {
  const [Sentry, { logger }] = await Promise.all([
    import("@sentry/node"),
    import("./lib/logger"),
  ]);
  const dsn = process.env["SENTRY_DSN"];

  if (dsn) {
    Sentry.init({
      dsn,
      environment: process.env["NODE_ENV"] ?? "development",
      // Error tracking only — no performance/tracing overhead.
      tracesSampleRate: 0,
      // With tracing off there is nothing for Sentry's ESM loader hook to
      // instrument, so do not register it: it starts a loader thread and wraps
      // every later import, which slows the rest of startup. The SDK is bundled
      // (see build.mjs), so the hook could not resolve its module anyway.
      registerEsmLoaderHooks: false,
      // Express is intentionally not instrumented because this service only
      // reports errors. Keep the SDK from emitting its tracing-only warning.
      disableInstrumentationWarnings: true,
    });
    logger.info("Sentry error monitoring initialized");
  } else {
    logger.warn(
      "SENTRY_DSN is not set; uncaught errors will not be reported to Sentry",
    );
  }
}
