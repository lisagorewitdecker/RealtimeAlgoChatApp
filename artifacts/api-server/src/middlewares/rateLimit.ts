import type { NextFunction, Request, RequestHandler, Response } from "express";

interface RateLimitOptions {
  maxRequests: number;
  scope: string;
  windowMs: number;
}

interface RateLimitWindow {
  count: number;
  startedAt: number;
}

const RATE_LIMIT_TRACKING_KEY_LIMIT = 10_000;

export function createIpRateLimit({
  maxRequests,
  scope,
  windowMs,
}: RateLimitOptions): RequestHandler {
  if (process.env["NODE_ENV"] === "production") {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const windows = new Map<string, RateLimitWindow>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    pruneRateLimitWindows(windows, now, windowMs);
    const key = getRateLimitKey(scope, req);
    const current = incrementRateLimitWindow(windows, key, now, windowMs);

    if (current.count <= maxRequests) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.startedAt + windowMs - now) / 1_000),
    );
    res
      .status(429)
      .setHeader("Retry-After", String(retryAfterSeconds))
      .json({ error: "Too many requests. Please try again later." });
  };
}

function getRateLimitKey(scope: string, req: Request): string {
  return `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function incrementRateLimitWindow(
  windows: Map<string, RateLimitWindow>,
  key: string,
  now: number,
  windowMs: number,
): RateLimitWindow {
  const current = windows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    const created = { startedAt: now, count: 1 };
    windows.set(key, created);
    return created;
  }

  current.count += 1;
  return current;
}

function pruneRateLimitWindows(
  windows: Map<string, RateLimitWindow>,
  now: number,
  windowMs: number,
): void {
  for (const [key, window] of windows) {
    if (now - window.startedAt >= windowMs) {
      windows.delete(key);
    }
  }

  while (windows.size > RATE_LIMIT_TRACKING_KEY_LIMIT) {
    const oldest = findOldestRateLimitKey(windows);
    if (typeof oldest !== "string") break;
    windows.delete(oldest);
  }
}

function findOldestRateLimitKey(
  windows: Map<string, RateLimitWindow>,
): string | undefined {
  let oldestKey: string | undefined;
  let oldestStartedAt = Number.POSITIVE_INFINITY;
  for (const [key, window] of windows) {
    if (window.startedAt < oldestStartedAt) {
      oldestKey = key;
      oldestStartedAt = window.startedAt;
    }
  }

  return oldestKey;
}
