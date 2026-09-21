import { Sentry, sentryEnabled } from "./sentry";
import { logger } from "./logger";

// Sentry Cron Monitor slug. Sentry expects a check-in at least this often;
// if none arrives (e.g. the process crashed or hung), Sentry marks the
// monitor "missed" and alerts the team via the project's default issue
// alert rule — a "dead man's switch" that catches full outages, not just
// errors reported from within a live process.
const MONITOR_SLUG = "api-server-healthz";
const READINESS_PATH = "/api/healthz";
const CHECK_INTERVAL_MINUTES = 5;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_REPORTED_ELAPSED_MS = 60_000;

export type ReadinessFailureReason = "timeout" | "connection" | "unknown";

export interface ReadinessFailureDetails {
  reason: ReadinessFailureReason;
  elapsedMs: number;
}

function isReadinessFailureReason(
  value: unknown,
): value is ReadinessFailureReason {
  return value === "timeout" || value === "connection" || value === "unknown";
}

export function parseReadinessFailureBody(
  body: unknown,
): ReadinessFailureDetails | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const { reason, elapsedMs } = record;
  if (
    !isReadinessFailureReason(reason) ||
    typeof elapsedMs !== "number" ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > MAX_REPORTED_ELAPSED_MS
  ) {
    return undefined;
  }

  return { reason, elapsedMs };
}

class ReadinessFailureError extends Error {
  constructor(
    readonly status: number,
    readonly details: ReadinessFailureDetails,
  ) {
    super(
      `${READINESS_PATH} responded with status ${status} ` +
        `(reason=${details.reason}, elapsedMs=${details.elapsedMs})`,
    );
    this.name = "ReadinessFailureError";
  }
}

async function readReadinessFailureDetails(
  response: Response,
): Promise<ReadinessFailureDetails | undefined> {
  if (response.status !== 503) {
    return undefined;
  }

  try {
    return parseReadinessFailureBody(await response.json());
  } catch {
    return undefined;
  }
}

export async function pingHealthz(port: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${READINESS_PATH}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const details = await readReadinessFailureDetails(res);
      if (details) {
        throw new ReadinessFailureError(res.status, details);
      }
      throw new Error(`${READINESS_PATH} responded with status ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Starts a recurring uptime check against this server's own readiness endpoint,
 * reported to Sentry as a Cron Monitor check-in. Requires SENTRY_DSN — without
 * it there is nowhere to send the alert, so the check is skipped entirely
 * rather than silently doing nothing useful.
 */
export function startHealthMonitor(port: number): void {
  if (!sentryEnabled) {
    logger.warn(
      `Sentry is disabled; skipping the ${READINESS_PATH} uptime monitor`,
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
      if (err instanceof ReadinessFailureError) {
        Sentry.captureException(err, {
          tags: { readinessFailureReason: err.details.reason },
          extra: { elapsedMs: err.details.elapsedMs },
        });
        logger.error(
          {
            err,
            reason: err.details.reason,
            elapsedMs: err.details.elapsedMs,
          },
          `${READINESS_PATH} uptime check failed`,
        );
        return;
      }

      Sentry.captureException(err);
      logger.error({ err }, `${READINESS_PATH} uptime check failed`);
    });
  };

  runCheck();
  setInterval(runCheck, CHECK_INTERVAL_MS).unref();
}
