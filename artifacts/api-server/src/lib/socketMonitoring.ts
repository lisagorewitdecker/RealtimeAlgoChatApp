import { Sentry, sentryEnabled } from "./sentry";
import { logger } from "./logger";

/**
 * Tracks how often an event happens within a rolling time window and raises
 * a single Sentry alert once the count crosses a threshold, then stays
 * quiet for a cooldown period. This turns a flood of individual failures
 * (e.g. every rejected handshake during a bad deploy) into one actionable
 * Sentry issue instead of one event per failure.
 */
class RateAlert {
  private readonly timestamps: number[] = [];
  private lastAlertAt = 0;

  constructor(
    private readonly options: {
      /** Human-readable label used in the Sentry message and log line. */
      label: string;
      /** Size of the rolling window, in milliseconds. */
      windowMs: number;
      /** Number of occurrences within the window that triggers an alert. */
      threshold: number;
      /** Minimum time between alerts, so a sustained spike files one issue, not one per event. */
      cooldownMs: number;
    },
  ) {}

  record(context: Record<string, unknown> = {}): void {
    const now = Date.now();
    this.timestamps.push(now);
    const cutoff = now - this.options.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }

    if (
      this.timestamps.length < this.options.threshold ||
      now - this.lastAlertAt < this.options.cooldownMs
    ) {
      return;
    }

    this.lastAlertAt = now;
    const windowSeconds = Math.round(this.options.windowMs / 1000);
    const message = `${this.options.label}: ${this.timestamps.length} in the last ${windowSeconds}s`;
    logger.error({ ...context, count: this.timestamps.length }, message);
    if (sentryEnabled) {
      Sentry.captureMessage(message, {
        level: "error",
        extra: { ...context, count: this.timestamps.length },
      });
    }
  }
}

/**
 * Reads a positive-integer tuning value from an environment variable,
 * falling back to `fallback` when the variable is unset, not a number, or
 * not positive. Invalid values are logged rather than thrown, since a
 * malformed tunable should never be able to crash server startup.
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { name, raw, fallback },
      `Ignoring invalid ${name} value; using the default`,
    );
    return fallback;
  }
  return parsed;
}

// Defaults are deliberately conservative heuristics, not measured
// baselines -- this app has not run with real chat traffic long enough to
// know its normal auth-failure/disconnect rates. The goal is to catch a
// step-change (e.g. a bad deploy that rejects every handshake, or a crash
// loop that disconnects everyone) rather than to alert on ordinary
// day-to-day churn.
//
// Every value is overridable via environment variable so that once real
// production volume is observed, the alert can be retuned with a config
// change instead of a code change and redeploy.
const authFailureAlert = new RateAlert({
  label: "Elevated Socket.IO auth-failure rate",
  windowMs: readPositiveIntEnv("SOCKET_AUTH_FAILURE_ALERT_WINDOW_MS", 60_000),
  threshold: readPositiveIntEnv("SOCKET_AUTH_FAILURE_ALERT_THRESHOLD", 10),
  cooldownMs: readPositiveIntEnv(
    "SOCKET_AUTH_FAILURE_ALERT_COOLDOWN_MS",
    5 * 60_000,
  ),
});

const disconnectAlert = new RateAlert({
  label: "Elevated Socket.IO disconnect rate",
  windowMs: readPositiveIntEnv("SOCKET_DISCONNECT_ALERT_WINDOW_MS", 60_000),
  threshold: readPositiveIntEnv("SOCKET_DISCONNECT_ALERT_THRESHOLD", 30),
  cooldownMs: readPositiveIntEnv(
    "SOCKET_DISCONNECT_ALERT_COOLDOWN_MS",
    5 * 60_000,
  ),
});

/** Call whenever the connection middleware rejects a handshake. */
export function recordSocketAuthFailure(reason: string): void {
  authFailureAlert.record({ reason });
}

/** Call for every socket disconnect, regardless of reason. */
export function recordSocketDisconnect(reason: string): void {
  disconnectAlert.record({ reason });
}

/**
 * Reports a bug that broke a Socket.IO event handler (e.g. an unexpected
 * database error inside "join-room") as a Sentry issue in addition to the
 * pino log line, so it surfaces without relying on a user reporting dropped
 * chats.
 */
export function reportSocketHandlerError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  logger.error({ err: error, event, ...context }, `Socket.IO "${event}" handler failed`);
  if (sentryEnabled) {
    Sentry.captureException(error, { tags: { socketEvent: event }, extra: context });
  }
}
