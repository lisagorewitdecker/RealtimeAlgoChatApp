import { clerkErrorStatus, clerkRetryAfterSeconds } from "./clerkRetry.js";

// Deliberately separate from accountAccess.ts: the route and socket tests
// replace that module with a mock factory, and the error type must stay real
// there so `instanceof` checks in the HTTP and handshake paths keep working.

/**
 * Machine-readable code shared by the HTTP 503 body and the Socket.IO
 * `connect_error` data when an account-access lookup cannot reach a verdict.
 */
export const ACCOUNT_ACCESS_UNAVAILABLE_CODE = "ACCOUNT_ACCESS_UNAVAILABLE";

export const ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE =
  "Account access is temporarily unavailable.";

/**
 * Hint used when a failure reached the HTTP or socket layer without Clerk
 * retry guidance attached (anything other than an
 * `AccountAccessUnavailableError`). One second matches the smallest hint the
 * lookup itself ever produces (its 250 ms exponential fallback, rounded up).
 */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * The `cause` of an `AccountAccessUnavailableError` when a Clerk request was
 * still in flight as the lookup's total time budget ran out. Carries no Clerk
 * retry guidance, so the hint falls back to the policy's exponential delay.
 */
export class AccountAccessDeadlineError extends Error {
  override readonly name = "AccountAccessDeadlineError";

  constructor(budgetMs: number) {
    super(
      `Clerk did not answer within the ${String(budgetMs)} ms account-access budget.`,
    );
  }
}

/**
 * Raised by `getAccountAccess` when Clerk could not say whether the account
 * may enter: the lookup ran out of attempts or out of its total time budget
 * (including a request still pending at the deadline), or Clerk answered with
 * an error that is not worth retrying. The underlying error is kept as
 * `cause`; the retry hint is Clerk's own guidance for the *next* attempt,
 * already capped by the shared policy, so callers can pass it straight to
 * clients instead of holding their request while waiting it out server-side.
 */
export class AccountAccessUnavailableError extends Error {
  override readonly name = "AccountAccessUnavailableError";
  /** Milliseconds a client should wait before retrying (capped per policy). */
  readonly retryAfterMs: number;
  /** Clerk requests the lookup made before giving up. */
  readonly attempts: number;
  /** HTTP status Clerk answered with, when it answered at all. */
  readonly status: number | undefined;

  constructor(
    cause: unknown,
    details: { retryAfterMs: number; attempts: number },
  ) {
    super(ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE, { cause });
    this.retryAfterMs = details.retryAfterMs;
    this.attempts = details.attempts;
    this.status = clerkErrorStatus(cause);
  }

  /** The hint in whole seconds, ready for `Retry-After` or a socket payload. */
  get retryAfterSeconds(): number {
    return clerkRetryAfterSeconds(this.retryAfterMs);
  }
}

/**
 * Whole seconds a client should wait before repeating a request whose
 * account-access lookup failed with `error`.
 */
export function accountAccessRetryAfterSeconds(error: unknown): number {
  return error instanceof AccountAccessUnavailableError
    ? error.retryAfterSeconds
    : DEFAULT_RETRY_AFTER_SECONDS;
}
