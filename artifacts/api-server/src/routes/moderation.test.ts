import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuth = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockIsConfiguredAdmin = vi.hoisted(() => vi.fn());
const mockSetAccountBan = vi.hoisted(() => vi.fn());
const mockSearchAccounts = vi.hoisted(() => vi.fn());
const mockDisconnectBannedUser = vi.hoisted(() => vi.fn());
const mockKickRoomMember = vi.hoisted(() => vi.fn());
const mockKickRoomUser = vi.hoisted(() => vi.fn());
const mockListModerationActions = vi.hoisted(() => vi.fn());
const mockRecordModerationAction = vi.hoisted(() => vi.fn());
const mockRecordMessageDeletion = vi.hoisted(() => vi.fn());
const mockBroadcastMessageDeletion = vi.hoisted(() => vi.fn());
const mockDbLimit = vi.hoisted(() => vi.fn());
const mockDbValues = vi.hoisted(() => vi.fn());
const mockDbReturning = vi.hoisted(() => vi.fn());

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
      values: mockDbValues,
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: mockDbReturning,
        }),
      }),
    })),
  },
  roomsTable: {
    id: "rooms.id",
    createdBy: "rooms.createdBy",
  },
  roomBansTable: {
    id: "roomBans.id",
    roomId: "roomBans.roomId",
    userId: "roomBans.userId",
    expiresAt: "roomBans.expiresAt",
  },
  messagesTable: {
    id: "messages.id",
    roomId: "messages.roomId",
    deletedAt: "messages.deletedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  gt: (left: unknown, right: unknown) => ({ left, right }),
  isNull: (value: unknown) => ({ value }),
  or: (...args: unknown[]) => args,
}));

vi.mock("@clerk/express", () => ({
  getAuth: mockGetAuth,
}));

vi.mock("../lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: mockIsConfiguredAdmin,
  setAccountBan: mockSetAccountBan,
}));

vi.mock("../lib/accountProfile", async () => {
  const actual = await vi.importActual<typeof import("../lib/accountProfile")>(
    "../lib/accountProfile",
  );
  return {
    ...actual,
    searchAccounts: mockSearchAccounts,
  };
});

vi.mock("../lib/moderationHistory", () => ({
  listModerationActions: mockListModerationActions,
  recordMessageDeletion: mockRecordMessageDeletion,
  recordModerationAction: mockRecordModerationAction,
}));

vi.mock("../socket", () => ({
  broadcastMessageDeletion: mockBroadcastMessageDeletion,
  disconnectBannedUser: mockDisconnectBannedUser,
  kickRoomMember: mockKickRoomMember,
  kickRoomUser: mockKickRoomUser,
}));

import moderationRouter, { resetModerationHistoryRateLimits } from "./moderation.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", moderationRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  resetModerationHistoryRateLimits();
  mockGetAuth.mockReset().mockReturnValue({ userId: "admin-ada" });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockIsConfiguredAdmin
    .mockReset()
    .mockImplementation((userId: string) => userId === "admin-ada");
  mockSetAccountBan.mockReset().mockResolvedValue(undefined);
  mockDisconnectBannedUser.mockReset();
  mockKickRoomMember.mockReset();
  mockKickRoomUser.mockReset().mockResolvedValue(undefined);
  mockDbLimit.mockReset().mockResolvedValue([]);
  mockDbValues.mockReset().mockResolvedValue(undefined);
  mockListModerationActions.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  mockRecordModerationAction.mockReset().mockResolvedValue(undefined);
  mockRecordMessageDeletion.mockReset().mockResolvedValue(undefined);
  mockBroadcastMessageDeletion.mockReset();
  mockDbReturning.mockReset().mockResolvedValue([]);
  mockSearchAccounts.mockReset().mockResolvedValue([
    {
      userId: "user-ben",
      username: "Ben",
      avatarEmoji: "🧑‍🚀",
      email: "ben@example.com",
      banned: false,
    },
  ]);
});

describe("message deletion", () => {
  it("soft-deletes a room message before broadcasting its tombstone", async () => {
    mockGetAuth.mockReturnValue({ userId: "owner-ada" });
    mockIsConfiguredAdmin.mockReturnValue(false);
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "owner-ada" }]);
    mockDbReturning.mockResolvedValueOnce([{ id: "message-1" }]);

    const response = await fetch(`${baseUrl}/room-123/messages/message-1`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockDbReturning).toHaveBeenCalled();
    expect(mockBroadcastMessageDeletion).toHaveBeenCalledWith(
      "room-123",
      "message-1",
    );
    expect(mockRecordMessageDeletion).toHaveBeenCalledWith(
      "owner-ada",
      "room-123",
      "message-1",
    );
    expect(mockDbReturning.mock.invocationCallOrder[0]).toBeLessThan(
      mockBroadcastMessageDeletion.mock.invocationCallOrder[0],
    );
  });

  it("does not delete or broadcast when the actor does not own the room", async () => {
    mockGetAuth.mockReturnValue({ userId: "user-ben" });
    mockIsConfiguredAdmin.mockReturnValue(false);
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "owner-ada" }]);

    const response = await fetch(`${baseUrl}/room-123/messages/message-1`, {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
    expect(mockDbReturning).not.toHaveBeenCalled();
    expect(mockBroadcastMessageDeletion).not.toHaveBeenCalled();
    expect(mockRecordMessageDeletion).not.toHaveBeenCalled();
  });

  it("allows a configured admin to delete a message in another owner's room", async () => {
    mockGetAuth.mockReturnValue({ userId: "admin-ada" });
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "owner-ada" }]);
    mockDbReturning.mockResolvedValueOnce([{ id: "message-1" }]);

    const response = await fetch(`${baseUrl}/room-123/messages/message-1`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(mockBroadcastMessageDeletion).toHaveBeenCalledWith(
      "room-123",
      "message-1",
    );
    expect(mockRecordMessageDeletion).toHaveBeenCalledWith(
      "admin-ada",
      "room-123",
      "message-1",
    );
  });

  it("does not broadcast when the room-scoped active message update finds nothing", async () => {
    mockGetAuth.mockReturnValue({ userId: "owner-ada" });
    mockIsConfiguredAdmin.mockReturnValue(false);
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "owner-ada" }]);
    mockDbReturning.mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/room-123/messages/other-room-message`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(mockBroadcastMessageDeletion).not.toHaveBeenCalled();
    expect(mockRecordMessageDeletion).not.toHaveBeenCalled();
  });
});

describe("room kicks", () => {
  it("returns success when the authoritative helper allows an admin kick", async () => {
    mockGetAuth.mockReturnValue({ userId: "admin-ada" });
    mockKickRoomMember.mockResolvedValue("ok");

    const response = await fetch(`${baseUrl}/room-123/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-ben" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockKickRoomMember).toHaveBeenCalledWith(
      "room-123",
      "admin-ada",
      "user-ben",
    );
  });

  it("preserves protected-admin results and normalizes the target ID", async () => {
    mockGetAuth.mockReturnValue({ userId: "owner-ada" });
    mockKickRoomMember.mockResolvedValue("protected-target");

    const response = await fetch(`${baseUrl}/room-123/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "  admin-lisa  " }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrators cannot be removed from rooms.",
    });
    expect(mockKickRoomMember).toHaveBeenCalledWith(
      "room-123",
      "owner-ada",
      "admin-lisa",
    );
  });
});

describe("room bans", () => {
  it("persists a creator-issued room ban and only kicks the target", async () => {
    mockGetAuth.mockReturnValue({ userId: "owner-ada" });
    mockIsConfiguredAdmin.mockReturnValue(false);
    mockDbLimit
      .mockResolvedValueOnce([{ createdBy: "owner-ada" }])
      .mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/room-123/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-ben", reason: "Repeated disruption" }),
    });

    expect(response.status).toBe(200);
    expect(mockDbValues).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-123",
        userId: "user-ben",
        bannedBy: "owner-ada",
        isPermanent: false,
        reason: "Repeated disruption",
      }),
    );
    expect(mockKickRoomUser).toHaveBeenCalledWith(
      "room-123",
      "user-ben",
      true,
    );
  });

  it("denies a non-admin when persisted room ownership belongs to someone else", async () => {
    mockGetAuth.mockReturnValue({ userId: "not-the-owner" });
    mockIsConfiguredAdmin.mockReturnValue(false);
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "persisted-owner" }]);

    const response = await fetch(`${baseUrl}/room-123/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-ben" }),
    });

    expect(response.status).toBe(403);
    expect(mockDbValues).not.toHaveBeenCalled();
    expect(mockKickRoomUser).not.toHaveBeenCalled();
  });

  it("allows a configured admin using the persisted room record", async () => {
    mockGetAuth.mockReturnValue({ userId: "admin-ada" });
    mockIsConfiguredAdmin.mockImplementation(
      (userId: string) => userId === "admin-ada",
    );
    mockDbLimit
      .mockResolvedValueOnce([{ createdBy: "persisted-owner" }])
      .mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/room-123/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-ben" }),
    });

    expect(response.status).toBe(200);
    expect(mockDbValues).toHaveBeenCalledWith(
      expect.objectContaining({
        isPermanent: true,
        expiresAt: null,
      }),
    );
  });

  it("prevents a room creator from banning a configured administrator", async () => {
    mockGetAuth.mockReturnValue({ userId: "owner-ada" });
    mockIsConfiguredAdmin.mockImplementation(
      (userId: string) => userId === "admin-lisa",
    );
    mockDbLimit.mockResolvedValueOnce([{ createdBy: "owner-ada" }]);

    const response = await fetch(`${baseUrl}/room-123/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "  admin-lisa  " }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrators cannot be banned from rooms.",
    });
    expect(mockDbValues).not.toHaveBeenCalled();
    expect(mockKickRoomUser).not.toHaveBeenCalled();
  });
});

describe("account search for moderation", () => {
  it("rejects search for a signed-out request", async () => {
    mockGetAuth.mockReturnValue({ userId: null });

    const response = await fetch(`${baseUrl}/search?query=ben`);

    expect(response.status).toBe(401);
    expect(mockSearchAccounts).not.toHaveBeenCalled();
  });

  it("rejects search for a non-administrator account", async () => {
    mockIsConfiguredAdmin.mockReturnValue(false);

    const response = await fetch(`${baseUrl}/search?query=ben`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator permission required.",
    });
    expect(mockSearchAccounts).not.toHaveBeenCalled();
  });

  it("rejects a query that is too short to search safely", async () => {
    const response = await fetch(`${baseUrl}/search?query=b`);

    expect(response.status).toBe(400);
    expect(mockSearchAccounts).not.toHaveBeenCalled();
  });

  it("rejects a missing query", async () => {
    const response = await fetch(`${baseUrl}/search`);

    expect(response.status).toBe(400);
    expect(mockSearchAccounts).not.toHaveBeenCalled();
  });

  it("returns minimal candidate accounts for an administrator's query", async () => {
    const response = await fetch(`${baseUrl}/search?query=ben`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          userId: "user-ben",
          username: "Ben",
          avatarEmoji: "🧑‍🚀",
          email: "ben@example.com",
          banned: false,
        },
      ],
    });
    expect(mockSearchAccounts).toHaveBeenCalledWith("ben");
  });
});

describe("account ban and restore", () => {
  it("bans a target account for an administrator and records who did it", async () => {
    const response = await fetch(`${baseUrl}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "  user-ben  " }),
    });

    expect(response.status).toBe(200);
    expect(mockSetAccountBan).toHaveBeenCalledWith("user-ben", true);
    expect(mockDisconnectBannedUser).toHaveBeenCalledWith("user-ben");
    await vi.waitFor(() =>
      expect(mockRecordModerationAction).toHaveBeenCalledWith(
        "ban",
        "admin-ada",
        "user-ben",
      ),
    );
  });

  it("prevents an administrator from banning their own account", async () => {
    const response = await fetch(`${baseUrl}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: " admin-ada " }),
    });

    expect(response.status).toBe(403);
    expect(mockSetAccountBan).not.toHaveBeenCalled();
    expect(mockDisconnectBannedUser).not.toHaveBeenCalled();
    expect(mockRecordModerationAction).not.toHaveBeenCalled();
  });

  it("prevents an administrator from banning another configured administrator", async () => {
    mockIsConfiguredAdmin.mockImplementation((userId: string) =>
      ["admin-ada", "admin-lisa"].includes(userId),
    );

    const response = await fetch(`${baseUrl}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: " admin-lisa " }),
    });

    expect(response.status).toBe(403);
    expect(mockSetAccountBan).not.toHaveBeenCalled();
    expect(mockDisconnectBannedUser).not.toHaveBeenCalled();
    expect(mockRecordModerationAction).not.toHaveBeenCalled();
  });

  it("restores a target account for an administrator and records who did it", async () => {
    const response = await fetch(`${baseUrl}/ban/user-ben`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(mockSetAccountBan).toHaveBeenCalledWith("user-ben", false);
    await vi.waitFor(() =>
      expect(mockRecordModerationAction).toHaveBeenCalledWith(
        "restore",
        "admin-ada",
        "user-ben",
      ),
    );
  });

  it("rejects ban and restore for a non-administrator account", async () => {
    mockIsConfiguredAdmin.mockReturnValue(false);

    const response = await fetch(`${baseUrl}/ban/user-ben`, { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(mockSetAccountBan).not.toHaveBeenCalled();
    expect(mockRecordModerationAction).not.toHaveBeenCalled();
  });
});

describe("moderation history", () => {
  it("rejects history for a signed-out request", async () => {
    mockGetAuth.mockReturnValue({ userId: null });

    const response = await fetch(`${baseUrl}/history`);

    expect(response.status).toBe(401);
    expect(mockListModerationActions).not.toHaveBeenCalled();
  });

  it("rejects history for a non-administrator account", async () => {
    mockIsConfiguredAdmin.mockReturnValue(false);

    const response = await fetch(`${baseUrl}/history`);

    expect(response.status).toBe(403);
    expect(mockListModerationActions).not.toHaveBeenCalled();
  });

  it("returns recorded ban/restore actions for an administrator", async () => {
    mockListModerationActions.mockResolvedValue({
      entries: [
        {
          id: 1,
          action: "ban",
          actorUserId: "admin-ada",
          actorUsername: "Ada",
          targetUserId: "user-ben",
          targetUsername: "Ben",
          targetEmail: "ben@example.com",
          createdAt: "2026-08-20T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    const response = await fetch(`${baseUrl}/history`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      actions: [
        {
          id: 1,
          action: "ban",
          actorUserId: "admin-ada",
          actorUsername: "Ada",
          targetUserId: "user-ben",
          targetUsername: "Ben",
          targetEmail: "ben@example.com",
          createdAt: "2026-08-20T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(mockListModerationActions).toHaveBeenCalledWith({
      cursor: undefined,
      targetUserId: undefined,
      actorUserId: undefined,
    });
  });

  it("passes cursor and filters through to the history query", async () => {
    mockListModerationActions.mockResolvedValue({ entries: [], nextCursor: 5 });

    const response = await fetch(
      `${baseUrl}/history?cursor=10&targetUserId=user-ben&actorUserId=admin-ada`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actions: [], nextCursor: 5 });
    expect(mockListModerationActions).toHaveBeenCalledWith({
      cursor: 10,
      targetUserId: "user-ben",
      actorUserId: "admin-ada",
    });
  });

  it("rejects a non-numeric history cursor", async () => {
    const response = await fetch(`${baseUrl}/history?cursor=not-a-number`);

    expect(response.status).toBe(400);
    expect(mockListModerationActions).not.toHaveBeenCalled();
  });

  it("rate limits repeated moderation history requests", async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${baseUrl}/history`);
      expect(response.status).toBe(200);
    }

    const response = await fetch(`${baseUrl}/history`);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Too many moderation history requests. Please try again later.",
    });
    expect(mockListModerationActions).toHaveBeenCalledTimes(30);
  });
});
