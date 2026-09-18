import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { createIpRateLimit } from "../middlewares/rateLimit";

const router: IRouter = Router();
const READINESS_QUERY_TIMEOUT_MS = 5_000;

const livenessRateLimit = createIpRateLimit({
  scope: "health-liveness",
  windowMs: 60_000,
  maxRequests: 60,
});
const timeoutErrorCodes = new Set(["ETIMEDOUT", "57014"]);
const connectionErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
]);
const readinessRateLimit = createIpRateLimit({
  scope: "health-readiness",
  windowMs: 60_000,
  maxRequests: 60,
});
const readinessQuery = {
  text: "SELECT 1",
  // node-postgres supports this per-query option at runtime, although its
  // QueryConfig type only exposes the same option at client configuration.
  query_timeout: READINESS_QUERY_TIMEOUT_MS,
};

export type ReadinessFailureReason = "timeout" | "connection" | "unknown";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }

  return "";
}

export function classifyReadinessError(
  error: unknown,
): ReadinessFailureReason {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

  if (
    (code && timeoutErrorCodes.has(code)) ||
    /\btimeout\b|\btimed out\b|statement timeout/i.test(message)
  ) {
    return "timeout";
  }

  if (
    (code && connectionErrorCodes.has(code)) ||
    /\bconnection\b|\bconnect\b/i.test(message)
  ) {
    return "connection";
  }

  return "unknown";
}

router.get("/healthz", healthRateLimit, async (_req, res) => {
  const startedAt = Date.now();

  try {
    await pool.query(readinessQuery);
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const reason = classifyReadinessError(error);
    logger.warn(
      { reason, elapsedMs },
      "Database readiness check failed",
    );
    res.status(503).json({ status: "unavailable", reason, elapsedMs });
  }
});

export default router;

const readinessRateLimit = createIpRateLimit({
  scope: "health-readiness",
  windowMs: 60_000,
  maxRequests: 60,
});
