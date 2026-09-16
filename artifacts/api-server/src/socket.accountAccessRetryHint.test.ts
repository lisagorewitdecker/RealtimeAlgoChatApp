import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockRecordSocketAuthFailure = vi.hoisted(() => vi.fn());
const mockReportSocketHandlerError = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  verifyToken: mockVerifyToken,
}));

vi.mock("./lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: () => false,
}));

vi.mock("./lib/accountProfile", () => ({
  getAccountProfile: mockGetAccountProfile,
}));

vi.mock("./lib/sandboxAssistant", () => ({
  streamSandboxAssistant: vi.fn(),
}));

vi.mock("./lib/socketMonitoring", () => ({
  recordSocketAuthFailure: mockRecordSocketAuthFailure,
  recordSocketDisconnect: vi.fn(),
  reportSocketHandlerError: mockReportSocketHandlerError,
}));

vi.mock("./lib/logger", () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  AccountAccessDeadlineError,
  AccountAccessUnavailableError,
} from "./lib/accountAccessUnavailable.js";
import { MAX_CLERK_RETRY_DELAY_MS } from "./lib/clerkRetry.js";
import { createRoomAccessCapability } from "./lib/roomAccess.js";
import { setupSocketIO } from "./socket.js";

interface ConnectError extends Error {
  data?: unknown;
}

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  process.env["SESSION_SECRET"] = "socket-retry-hint-test-secret";
  mockVerifyToken.mockReset().mockResolvedValue({ sub: "user-ada" });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockGetAccountProfile
    .mockReset()
    .mockResolvedValue({ username: "Ada", avatarEmoji: "👩‍💻" });
  mockRecordSocketAuthFailure.mockReset();
  mockReportSocketHandlerError.mockReset();
  mockWarn.mockReset();

  httpServer = createServer();
  socketServer = setupSocketIO(httpServer);
  httpServer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function waitForEvent<T>(socket: ClientSocket, event: string) {
  return new Promise<T>((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

function connect(auth: Record<string, unknown>) {
  const client = createClient(serverUrl, {
    auth,
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  clients.push(client);
  return client;
}

function budgetExhausted() {
  return new AccountAccessUnavailableError(
    Object.assign(new Error("Too Many Requests"), {
      status: 429,
      retryAfter: 3_600,
    }),
    { retryAfterMs: MAX_CLERK_RETRY_DELAY_MS, attempts: 1 },
  );
}

const capabilityToken = () =>
  createRoomAccessCapability({
    roomId: "room-cap",
    userId: "user-cap",
    username: "Cap",
    avatarEmoji: "🧑‍💻",
    purpose: "call",
  });

describe("Socket.IO handshake retry hints while Clerk is throttled", () => {
  it.each([
    ["Clerk session token", () => ({ token: "token-ada" })],
    ["room-access capability", () => ({ token: capabilityToken() })],
  ])(
    "rejects a %s handshake with the same retry hint the HTTP 503 carries",
    async (_label, auth) => {
      mockGetAccountAccess.mockRejectedValue(budgetExhausted());

      const client = connect(auth());
      const error = await waitForEvent<ConnectError>(client, "connect_error");

      expect(error.message).toBe("Account access is temporarily unavailable.");
      expect(error.data).toEqual({
        code: "ACCOUNT_ACCESS_UNAVAILABLE",
        retryAfterSeconds: MAX_CLERK_RETRY_DELAY_MS / 1_000,
      });
      expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith(
        "account_access_unavailable",
      );
      // An upstream throttle is logged and rate-alerted, not filed as a
      // handler crash per handshake.
      expect(mockReportSocketHandlerError).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(AccountAccessUnavailableError),
          retryAfterSeconds: MAX_CLERK_RETRY_DELAY_MS / 1_000,
        }),
        "Account access check failed during socket handshake",
      );
    },
  );

  it.each([
    [
      "a short throttle hint",
      Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter: 0 }),
    ],
    ["a hung Clerk request that hit the lookup deadline", new AccountAccessDeadlineError(15_000)],
  ])("passes %s through in whole seconds", async (_label, cause) => {
    mockGetAccountAccess.mockRejectedValue(
      new AccountAccessUnavailableError(cause, { retryAfterMs: 250, attempts: 1 }),
    );

    const client = connect({ token: "token-ada" });
    const error = await waitForEvent<ConnectError>(client, "connect_error");

    expect(error.message).toBe("Account access is temporarily unavailable.");
    expect(error.data).toEqual({
      code: "ACCOUNT_ACCESS_UNAVAILABLE",
      retryAfterSeconds: 1,
    });
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith(
      "account_access_unavailable",
    );
  });

  it("releases the connection slot so the client can reconnect once the hint elapses", async () => {
    mockGetAccountAccess.mockRejectedValueOnce(budgetExhausted());

    const rejected = connect({ token: "token-ada" });
    await waitForEvent(rejected, "connect_error");

    const retried = connect({ token: "token-ada" });
    await waitForEvent(retried, "connect");
    expect(retried.connected).toBe(true);
  });

  it("keeps treating other handshake failures as unexpected errors", async () => {
    mockGetAccountAccess.mockRejectedValue(new Error("db unavailable"));

    const client = connect({ token: "token-ada" });
    const error = await waitForEvent<ConnectError>(client, "connect_error");

    expect(error.message).toBe("Invalid session.");
    expect(error.data).toBeUndefined();
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("unexpected_error");
    expect(mockReportSocketHandlerError).toHaveBeenCalledWith(
      "connection-auth",
      expect.any(Error),
    );
  });
});
