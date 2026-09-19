import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockCaptureMessage = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockDbLimit = vi.hoisted(() => vi.fn());

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

// Real socketMonitoring runs here (not mocked) so this test exercises the
// full path from a broken handler through to a reported Sentry issue. Only
// the Sentry SDK itself is mocked.
vi.mock("./lib/sentry", () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  sentryEnabled: true,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: mockDbLimit,
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    })),
  },
  roomBansTable: {
    id: "id",
    roomId: "roomId",
    userId: "userId",
    expiresAt: "expiresAt",
  },
  roomsTable: {
    id: "id",
    name: "name",
    createdBy: "createdBy",
    createdAt: "createdAt",
    lastAccessedAt: "lastAccessedAt",
    isActive: "isActive",
  },
  roomKickCooldownsTable: {
    roomId: "roomId",
    userId: "userId",
    expiresAt: "expiresAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  gt: (a: unknown, b: unknown) => ({ a, b }),
  isNull: (value: unknown) => ({ value }),
  or: (...args: unknown[]) => args,
}));

import { setupSocketIO } from "./socket.js";

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  mockVerifyToken.mockReset().mockResolvedValue({ sub: "user-ada" });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockGetAccountProfile
    .mockReset()
    .mockResolvedValue({ username: "Ada", avatarEmoji: "👩‍💻" });
  mockCaptureMessage.mockReset();
  mockCaptureException.mockReset();
  mockDbLimit.mockReset();

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

describe("Socket.IO handler crash reporting", () => {
  it("rejects an active persisted room ban with the exact client error", async () => {
    mockDbLimit.mockResolvedValueOnce([{ id: "ban-1" }]);

    const client = connect({ token: "good-token" });
    await waitForEvent(client, "connect");
    const error = waitForEvent<{ code: string; message: string }>(client, "error");

    client.emit("join-room", { roomId: "room-crash" });

    await expect(error).resolves.toEqual({
      code: "ROOM_BANNED",
      message: "You are banned from this room",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does not crash the server or leave the room broken after a join-room failure, and lets a retry succeed", async () => {
    mockDbLimit.mockRejectedValueOnce(new Error("db unavailable"));
    mockDbLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "room-retry",
          createdBy: "user-ada",
          createdAt: new Date(),
          lastAccessedAt: new Date(),
          isActive: true,
        },
      ]);

    const client = connect({ token: "good-token" });
    await waitForEvent(client, "connect");
    const error = waitForEvent<{ message: string }>(client, "error");

    client.emit("join-room", { roomId: "room-crash" });

    await expect(error).resolves.toEqual({
      message: "Unable to join this room. Please try again.",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(mockCaptureException.mock.calls[0]![1]).toMatchObject({
      tags: { socketEvent: "join-room" },
    });
  });

  it("does not crash the server or leave the room broken after a join-room failure, and lets a retry succeed", async () => {
    mockDbLimit.mockRejectedValueOnce(new Error("db unavailable"));
    mockDbLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "room-retry",
          createdBy: "user-ada",
          createdAt: new Date(),
          lastAccessedAt: new Date(),
          isActive: true,
        },
      ]);

    const client = connect({ token: "good-token" });
    await waitForEvent(client, "connect");
    const firstError = waitForEvent(client, "error");
    client.emit("join-room", { roomId: "room-retry" });
    await firstError;

    const joined = waitForEvent<{ roomId: string }>(client, "room-joined");
    client.emit("join-room", { roomId: "room-retry" });
    await expect(joined).resolves.toMatchObject({ roomId: "room-retry" });
  });
});
