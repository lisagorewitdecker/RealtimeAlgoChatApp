import * as Sentry from "@sentry/node";
import { isMainThread } from "node:worker_threads";
import { logger } from "./lib/logger";

const dsn = process.env["SENTRY_DSN"];

// Node workers inherit --import through execArgv. Initialize once in the
// server's main thread rather than once per pino transport worker.
if (isMainThread) {
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