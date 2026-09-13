const MAX_EXPONENTIAL_DELAY_MS = 30_000;

export function clerkErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : undefined;
}

export function clerkRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
): number {
  const retryAfter =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { retryAfter?: unknown }).retryAfter === "number" &&
    Number.isFinite((error as { retryAfter: number }).retryAfter) &&
    (error as { retryAfter: number }).retryAfter >= 0
      ? (error as { retryAfter: number }).retryAfter * 1_000
      : 0;
  const exponentialDelayMs = Math.min(
    MAX_EXPONENTIAL_DELAY_MS,
    baseDelayMs * 2 ** attempt,
  );
  return Math.max(retryAfter, exponentialDelayMs);
}