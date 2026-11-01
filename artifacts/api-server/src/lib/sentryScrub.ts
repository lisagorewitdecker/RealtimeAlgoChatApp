import type { Breadcrumb, Event } from "@sentry/node";

/**
 * Removes credentials from Sentry events and breadcrumbs before they leave the
 * process: Authorization/Cookie/Set-Cookie headers, request cookies, Bearer
 * tokens, and token-like query or cookie parameters (room access
 * capabilities, Clerk session and handshake values).
 */

export const SENTRY_FILTERED = "[Filtered]";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);
const SENSITIVE_PARAMETER = String.raw`token|access_token|id_token|capability|__session(?:_[\w-]+)?|__clerk_db_jwt(?:_[\w-]+)?|__clerk_handshake(?:_nonce)?|__clerk_testing_token|__dev_session|__client|__refresh(?:_[\w-]+)?`;
const SENSITIVE_PARAMETER_NAME = new RegExp(`^(?:${SENSITIVE_PARAMETER})$`, "i");
const SENSITIVE_PARAMETER_VALUE = new RegExp(
  String.raw`(^|[?&#;,\s])(${SENSITIVE_PARAMETER})=[^&#;,\s]*`,
  "gi",
);
const BEARER_TOKEN = /\bBearer\s+[^\s,;"']+/gi;
const MAX_DATA_DEPTH = 4;

type QueryParams = NonNullable<NonNullable<Event["request"]>["query_string"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_HEADERS.has(key.toLowerCase()) || SENSITIVE_PARAMETER_NAME.test(key)
  );
}

export function scrubSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_PARAMETER_VALUE, `$1$2=${SENTRY_FILTERED}`)
    .replace(BEARER_TOKEN, `Bearer ${SENTRY_FILTERED}`);
}

function scrubRecord(
  record: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      scrubbed[key] = SENTRY_FILTERED;
    } else if (typeof value === "string") {
      scrubbed[key] = scrubSensitiveText(value);
    } else if (isRecord(value) && depth < MAX_DATA_DEPTH) {
      scrubbed[key] = scrubRecord(value, depth + 1);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

function scrubQueryParams(query: QueryParams): QueryParams {
  if (typeof query === "string") return scrubSensitiveText(query);
  if (Array.isArray(query)) {
    return query.map(([key, value]): [string, string] => [
      key,
      isSensitiveKey(key) ? SENTRY_FILTERED : scrubSensitiveText(value),
    ]);
  }
  return scrubRecord(query) as Record<string, string>;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = scrubSensitiveText(breadcrumb.message);
  }
  if (breadcrumb.data) breadcrumb.data = scrubRecord(breadcrumb.data);
  return breadcrumb;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const request = event.request;
  if (request) {
    delete request.cookies;
    if (request.headers) {
      request.headers = scrubRecord(request.headers) as Record<string, string>;
    }
    if (typeof request.url === "string") {
      request.url = scrubSensitiveText(request.url);
    }
    if (request.query_string !== undefined) {
      request.query_string = scrubQueryParams(request.query_string);
    }
  }
  if (typeof event.message === "string") {
    event.message = scrubSensitiveText(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = scrubSensitiveText(exception.value);
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb);
  }
  return event;
}
