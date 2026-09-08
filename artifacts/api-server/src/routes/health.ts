import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();
const READINESS_QUERY_TIMEOUT_MS = 5_000;
const readinessQuery = {
  text: "SELECT 1",
  // node-postgres supports this per-query option at runtime, although its
  // QueryConfig type only exposes the same option at client configuration.
  query_timeout: READINESS_QUERY_TIMEOUT_MS,
};

router.get("/healthz", async (_req, res) => {
  try {
    await pool.query(readinessQuery);
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

export default router;
