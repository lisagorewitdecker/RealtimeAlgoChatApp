function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const delaySeconds = Number(value);
  if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
    return Math.ceil(delaySeconds);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  const secondsUntilRetry = Math.ceil((retryAt - Date.now()) / 1000);
  return secondsUntilRetry > 0 ? secondsUntilRetry : undefined;
}

export function getAssistantRateLimitCountdown(retryAfter: unknown): number {
  return typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
    ? Math.ceil(retryAfter)
    : 30;
}

export function isAnthropicRateLimitError(error: unknown): boolean {
  return getRecord(error)?.["status"] === 429;
}

export function getAnthropicRetryAfterSeconds(
  error: unknown,
): number | undefined {
  if (!isAnthropicRateLimitError(error)) return undefined;
  const headerValue = getRecord(error)?.["headers"];
  const getHeader =
    headerValue !== null &&
    typeof headerValue === "object" &&
    "get" in headerValue &&
    typeof headerValue.get === "function"
      ? (headerValue.get as (name: string) => unknown).bind(headerValue)
      : null;
  if (getHeader) {
    const value = getHeader("retry-after");
    return parseRetryAfterSeconds(value);
  }

  const headers = getRecord(headerValue);
  if (!headers) return undefined;
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  return parseRetryAfterSeconds(raw);
}