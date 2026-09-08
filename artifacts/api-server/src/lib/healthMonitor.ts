import { Sentry, sentryEnabled } from "./sentry";
import { logger } from "./logger";

// Sentry Cron Monitor slug. Sentry expects a check-in at least this often;
// if none arrives (e.g. the process crashed or hung), Sentry marks the
// monitor "missed" and alerts the team via the project's default issue
// alert rule — a "dead man's switch" that catches full outages, not just
// errors reported from within a live process.
const MONITOR_SLUG = "api-server-healthz";
const CHECK_INTERVAL_MINUTES = 5;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;

async function pingHealthz(port: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`/api/healthz responded with status ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Starts a recurring uptime check against this server's own /api/healthz
 * endpoint, reported to Sentry as a Cron Monitor check-in. Requires
 * SENTRY_DSN — without it there is nowhere to send the alert, so the check
 * is skipped entirely rather than silently doing nothing useful.
 */
export function startHealthMonitor(port: number): void {
  if (!sentryEnabled) {
    logger.warn(
      "Sentry is disabled; skipping the /api/healthz uptime monitor",
    );
    return;
  }

  const runCheck = (): void => {
    Sentry.withMonitor(
      MONITOR_SLUG,
      () => pingHealthz(port),
      {
        schedule: {
          type: "interval",
          value: CHECK_INTERVAL_MINUTES,
          unit: "minute",
        },
        // How late a check-in may arrive before Sentry considers it missed.
        checkinMargin: 2,
        // How long a single check is allowed to run before being marked failed.
        maxRuntime: 1,
        timezone: "Etc/UTC",
      },
    ).catch((err: unknown) => {
      logger.error({ err }, "/api/healthz uptime check failed");
    });
  };

  runCheck();
  setInterval(runCheck, CHECK_INTERVAL_MS).unref();
}
