/**
 * Longest single wait between Clerk attempts, in milliseconds.
 *
 * The ceiling applies to Clerk's own `retryAfter` guidance as well as to the
 * exponential fallback, and it is shared by the browser (Playwright) checks
 * and the server's account-access lookups. Guidance above the ceiling is
 * clamped rather than rejected, so an unexpectedly large upstream hint cannot
 * stall a check for longer than this while the attempt count stays the same.
 */
export const MAX_CLERK_RETRY_DELAY_MS = 30_000;

export function clerkErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : undefined;
}

/**
 * Clerk reports `retryAfter` in seconds. Anything that is not a finite,
 * non-negative number is treated as absent so the exponential fallback applies.
 */
function clerkRetryAfterMs(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const { retryAfter } = error as { retryAfter?: unknown };
  return typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
    ? retryAfter * 1_000
    : 0;
}

export function clerkRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
): number {
  const exponentialDelayMs = baseDelayMs * 2 ** attempt;
  return Math.min(
    MAX_CLERK_RETRY_DELAY_MS,
    Math.max(clerkRetryAfterMs(error), exponentialDelayMs),
  );
}
