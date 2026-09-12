const RETRYABLE_CLERK_STATUSES = new Set([429, 500, 502, 503, 504]);

type ClerkRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  logPrefix?: string;
  sleep?: (delayMs: number) => Promise<void>;
};

function clerkErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : undefined;
}

export async function withClerkRetry<T>(
  phase: string,
  operation: () => Promise<T>,
  options: ClerkRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("Clerk retry attempts must be a positive integer");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = clerkErrorStatus(error);
      if (
        !RETRYABLE_CLERK_STATUSES.has(status ?? 0) ||
        attempt === attempts - 1
      ) {
        break;
      }

      const delayMs = baseDelayMs * 2 ** attempt;
      console.info(
        `${options.logPrefix ?? "[clerk-e2e]"} ${phase} returned ${status}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function throwTestAndCleanupFailures(
  testFailure: unknown,
  cleanupErrors: unknown[],
  cleanupMessage: string,
  combinedMessage: string,
): void {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      testFailure === undefined
        ? cleanupErrors
        : [testFailure, ...cleanupErrors],
      testFailure === undefined ? cleanupMessage : combinedMessage,
    );
  }
  if (testFailure !== undefined) throw testFailure;
}