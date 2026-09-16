import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuth = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  getAuth: mockGetAuth,
}));

vi.mock("./accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
}));

vi.mock("./logger", () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

import { requireAuth } from "../middlewares/requireAuth.js";
import {
  AccountAccessDeadlineError,
  AccountAccessUnavailableError,
} from "./accountAccessUnavailable.js";
import { MAX_CLERK_RETRY_DELAY_MS } from "./clerkRetry.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.get("/protected", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  mockGetAuth.mockReset().mockReturnValue({ userId: "user-ada" });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockWarn.mockReset();
});

describe("requireAuthorizedUser retry hints", () => {
  it("lets an allowed account through", async () => {
    const response = await fetch(`${baseUrl}/protected`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("answers 503 with Clerk's capped guidance as Retry-After when the lookup exhausts its budget", async () => {
    const throttled = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      retryAfter: 3_600,
    });
    mockGetAccountAccess.mockRejectedValue(
      new AccountAccessUnavailableError(throttled, {
        retryAfterMs: MAX_CLERK_RETRY_DELAY_MS,
        attempts: 1,
      }),
    );

    const response = await fetch(`${baseUrl}/protected`);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(
      String(MAX_CLERK_RETRY_DELAY_MS / 1_000),
    );
    await expect(response.json()).resolves.toEqual({
      error: "Account access is temporarily unavailable.",
      code: "ACCOUNT_ACCESS_UNAVAILABLE",
      retryAfterSeconds: MAX_CLERK_RETRY_DELAY_MS / 1_000,
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(AccountAccessUnavailableError),
        retryAfterSeconds: MAX_CLERK_RETRY_DELAY_MS / 1_000,
      }),
      "Account access check failed",
    );
  });

  it("answers 503 with a retry hint when a hung Clerk request hit the lookup deadline", async () => {
    mockGetAccountAccess.mockRejectedValue(
      new AccountAccessUnavailableError(new AccountAccessDeadlineError(15_000), {
        retryAfterMs: 250,
        attempts: 1,
      }),
    );

    const response = await fetch(`${baseUrl}/protected`);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Account access is temporarily unavailable.",
      code: "ACCOUNT_ACCESS_UNAVAILABLE",
      retryAfterSeconds: 1,
    });
  });

  it("rounds a short retry hint up to a whole second", async () => {
    mockGetAccountAccess.mockRejectedValue(
      new AccountAccessUnavailableError(
        Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter: 2.5 }),
        { retryAfterMs: 2_500, attempts: 4 },
      ),
    );

    const response = await fetch(`${baseUrl}/protected`);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 3 });
  });

  it("still tells the client when to retry if the failure carries no Clerk guidance", async () => {
    mockGetAccountAccess.mockRejectedValue(new Error("unexpected"));

    const response = await fetch(`${baseUrl}/protected`);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Account access is temporarily unavailable.",
      code: "ACCOUNT_ACCESS_UNAVAILABLE",
      retryAfterSeconds: 1,
    });
  });
});
