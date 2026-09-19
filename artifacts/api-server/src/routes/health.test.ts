import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: mockWarn },
}));

import healthRouter, { classifyReadinessError } from "./health.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/", healthRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [{ "?column?": 1 }] });
  mockWarn.mockReset();
});

describe("classifyReadinessError", () => {
  it.each([
    ["query timeout message", new Error("Query read timeout"), "timeout"],
    [
      "PostgreSQL statement timeout",
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
      "timeout",
    ],
    [
      "connection refusal",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
      "connection",
    ],
    [
      "connection reset",
      Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      "connection",
    ],
    ["unknown error", new Error("database returned an unexpected result"), "unknown"],
  ])("classifies %s safely", (_label, error, expected) => {
    expect(classifyReadinessError(error)).toBe(expected);
  });
});

describe("GET /healthz", () => {
  it("returns a sanitized timeout reason and elapsed time", async () => {
    mockQuery.mockRejectedValueOnce(
      new Error(
        "Query read timeout for postgres://user:password@example.invalid/db",
      ),
    );

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      reason: string;
      elapsedMs: number;
    };
    expect(body).toMatchObject({
      status: "unavailable",
      reason: "timeout",
    });
    expect(body.elapsedMs).toEqual(expect.any(Number));
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mockWarn).toHaveBeenCalledWith(
      { reason: "timeout", elapsedMs: body.elapsedMs },
      "Database readiness check failed",
    );

    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).not.toContain("DATABASE_URL");
    expect(logged).not.toContain("password");
    expect(logged).not.toContain("postgres://");
  });

  it("returns healthy when the readiness query succeeds", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(mockWarn).not.toHaveBeenCalled();
  });
});