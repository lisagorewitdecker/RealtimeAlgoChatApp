import * as Sentry from "@sentry/node";
import { isMainThread } from "node:worker_threads";

// Node workers inherit --import through execArgv, so this module is evaluated
// again inside every pino transport worker. Nothing may run off the main
// thread: a static logger import here would build another transport-backed
// logger in each worker, which spawns another transport worker, which
// evaluates this module again — an unbounded chain of threads that grows until
// the process is killed. The logger is therefore loaded only after the check.
if (isMainThread) {
  const { logger } = await import("./lib/logger");
  const dsn = process.env["SENTRY_DSN"];

  if (dsn) {
    Sentry.init({
      dsn,
      environment: process.env["NODE_ENV"] ?? "development",
      // Error tracking only — no performance/tracing overhead.
      tracesSampleRate: 0,
    });
    logger.info("Sentry error monitoring initialized");
  } else {
    logger.warn(
      "SENTRY_DSN is not set; uncaught errors will not be reported to Sentry",
    );
  }
}
