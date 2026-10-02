import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";

const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockIsConfiguredAdmin = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  verifyToken: mockVerifyToken,
}));

vi.mock("./lib/accountProfile", () => ({
  getAccountProfile: mockGetAccountProfile,
}));

vi.mock("./lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: mockIsConfiguredAdmin,
}));

import {
  db,
  messagesTable,
  pool,
  roomBansTable,
  roomsTable,
} from "@workspace/db";
import {
  loadDeletedMessageIdsAfter,
  loadEncryptedMessagesAfter,
} from "./lib/e2eePersistence.js";
import {
  resetSocketRoomStateForTest,
  ROOM_INACTIVITY_TIMEOUT_MS,
  setRoomLastAccessedAtForTest,
  setupSocketIO,
} from "./socket.js";

interface RunningServer {
  httpServer: HttpServer;
  socketServer: ReturnType<typeof setupSocketIO>;
  url: string;
}

const clients: ClientSocket[] = [];
const roomIds = new Set<string>();
let runningServer: RunningServer | null = null;

interface ExplainPlan {
  [key: string]: unknown;
  Plans?: ExplainPlan[];
  "Index Name"?: string;
}

function collectIndexNames(plan: ExplainPlan): string[] {
  return [
    ...(typeof plan["Index Name"] === "string" ? [plan["Index Name"]] : []),
    ...(plan.Plans ?? []).flatMap(collectIndexNames),
  ];
}

function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function startServer(): Promise<RunningServer> {
  const httpServer = createServer();
  const socketServer = setupSocketIO(httpServer);
  httpServer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, socketServer, url: `http://127.0.0.1:${port}` };
}

async function stopServer(server: RunningServer): Promise<void> {
  clients.splice(0).forEach((client) => client.close());
  await new Promise<void>((resolve) => server.socketServer.close(() => resolve()));
  if (server.httpServer.listening) {
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createRoomClient(url: string): ClientSocket {
  const client = createClient(url, {
    auth: { token: "token-ben", username: "Ben", avatarEmoji: "🦊" },
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  clients.push(client);
  return client;
}

async function recoverPage(
  client: ClientSocket,
  roomId: string,
  requestId: string,
  cursor: { id: string; timestamp: number },
) {
  const response = waitForEvent<{
    requestId: string;
    messages: Array<{ id: string; timestamp: number }>;
    hasMore: boolean;
    nextCursor: { id: string; timestamp: number };
  }>(client, "message-recovery-page");
  client.emit("recover-messages", {
    requestId,
    roomId,
    afterMessageId: cursor.id,
    afterTimestamp: cursor.timestamp,
  });
  return response;
}

beforeAll(() => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required for database-backed message recovery.");
  }
  mockVerifyToken.mockImplementation(async (token: string) => {
    if (token === "token-ben") return { sub: "user-ben" };
    throw new Error("Invalid session");
  });
  mockGetAccountProfile.mockResolvedValue({
    username: "Ben",
    avatarEmoji: "🦊",
  });
  mockGetAccountAccess.mockResolvedValue({ allowed: true });
  mockIsConfiguredAdmin.mockReturnValue(false);
});

afterEach(async () => {
  if (runningServer) {
    await stopServer(runningServer);
    runningServer = null;
  }
  resetSocketRoomStateForTest();
  for (const roomId of roomIds) {
    await db.delete(roomsTable).where(eq(roomsTable.id, roomId));
  }
  roomIds.clear();
});

afterAll(async () => {
  await pool.end();
});

describe("database-backed Socket.IO message recovery", () => {
  it("pages room-scoped deletion tombstones on the deleted cursor index", async () => {
    const suffix = `${Date.now()}-${process.pid}`;
    const roomId = `db-deletion-cursor-${suffix}`;
    const otherRoomId = `db-deletion-other-${suffix}`;
    roomIds.add(roomId);
    roomIds.add(otherRoomId);
    await db.insert(roomsTable).values([
      {
        id: roomId,
        name: "Deletion cursor room",
        createdBy: "user-ada",
      },
      {
        id: otherRoomId,
        name: "Other deletion cursor room",
        createdBy: "user-grace",
      },
    ]);

    const baselineDeletedAt = new Date("2026-01-01T00:00:00.000Z");
    const sharedDeletedAt = new Date("2026-01-01T00:00:01.000Z");
    const laterDeletedAt = new Date("2026-01-01T00:00:02.000Z");
    const targetDeleted = Array.from({ length: 165 }, (_, index) => ({
      id: `${roomId}-deleted-${String(index + 1).padStart(3, "0")}`,
      roomId,
      userId: "user-ada",
      username: "Ada",
      ciphertext: `ciphertext-deleted-${index + 1}`,
      nonce: `nonce-deleted-${index + 1}`,
      type: "text" as const,
      timestampMs: index + 1,
      deletedAt: index < 164 ? sharedDeletedAt : laterDeletedAt,
    }));
    const plannerRows = Array.from({ length: 12_000 }, (_, index) => ({
      id: `${roomId}-planner-${String(index + 1).padStart(5, "0")}`,
      roomId,
      userId: "user-ada",
      username: "Ada",
      ciphertext: `ciphertext-planner-${index + 1}`,
      nonce: `nonce-planner-${index + 1}`,
      type: "text" as const,
      timestampMs: 1_000 + index,
      deletedAt: new Date(sharedDeletedAt.getTime() + 10_000 + index),
    }));
    const excludedRows = [
      {
        id: `${roomId}-active`,
        roomId,
        userId: "user-ada",
        username: "Ada",
        ciphertext: "ciphertext-active",
        nonce: "nonce-active",
        type: "text" as const,
        timestampMs: 999_999,
        deletedAt: null,
      },
      {
        id: `${otherRoomId}-deleted`,
        roomId: otherRoomId,
        userId: "user-grace",
        username: "Grace",
        ciphertext: "ciphertext-other-room",
        nonce: "nonce-other-room",
        type: "text" as const,
        timestampMs: 999_999,
        deletedAt: sharedDeletedAt,
      },
    ];
    const stored = [...targetDeleted, ...plannerRows, ...excludedRows];
    const insertBatchSize = 1_000;
    for (let start = 0; start < stored.length; start += insertBatchSize) {
      await db
        .insert(messagesTable)
        .values(stored.slice(start, start + insertBatchSize));
    }
    await pool.query("ANALYZE messages");

    const explained = await pool.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlan }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id, deleted_at
       FROM messages
       WHERE room_id = $1
         AND deleted_at IS NOT NULL
         AND (deleted_at > $2 OR (deleted_at = $2 AND id > $3))
       ORDER BY deleted_at ASC, id ASC
       LIMIT 81`,
      [
        roomId,
        plannerRows[11_899]!.deletedAt,
        plannerRows[11_899]!.id,
      ],
    );
    const plan = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
    expect(plan).toBeDefined();
    expect(collectIndexNames(plan!)).toContain(
      "messages_deleted_room_cursor_idx",
    );

    const baseline = { id: "", deletedAt: baselineDeletedAt.getTime() };
    const cappedPage = await loadDeletedMessageIdsAfter(roomId, baseline, 1_000);
    expect(cappedPage.tombstones).toHaveLength(80);
    expect(cappedPage.hasMore).toBe(true);

    const recovered: Array<{ id: string; deletedAt: number }> = [];
    let cursor = baseline;
    for (;;) {
      const page = await loadDeletedMessageIdsAfter(roomId, cursor, 80);
      recovered.push(...page.tombstones);
      if (!page.hasMore) break;
      cursor = page.tombstones.at(-1)!;
    }

    const expected = [...targetDeleted, ...plannerRows]
      .sort(
        (left, right) =>
          left.deletedAt.getTime() - right.deletedAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .map((message) => ({
        id: message.id,
        deletedAt: message.deletedAt.getTime(),
      }));
    expect(recovered).toEqual(expected);
    expect(new Set(recovered.map((item) => item.id)).size).toBe(recovered.length);
    expect(recovered).not.toContainEqual(
      expect.objectContaining({ id: excludedRows[0]!.id }),
    );
    expect(recovered).not.toContainEqual(
      expect.objectContaining({ id: excludedRows[1]!.id }),
    );

    const minimumPage = await loadDeletedMessageIdsAfter(roomId, baseline, 0);
    expect(minimumPage.tombstones).toEqual([expected[0]]);
    expect(minimumPage.hasMore).toBe(true);
  });

  it("keeps large-room recovery on the active cursor index", async () => {
    const roomId = `db-recovery-plan-${Date.now()}-${process.pid}`;
    roomIds.add(roomId);
    await db.insert(roomsTable).values({
      id: roomId,
      name: "Large database recovery",
      createdBy: "user-ada",
    });

    const messageCount = 12_000;
    const idPrefix = `${roomId}-message-`;
    const stored = Array.from({ length: messageCount }, (_, index) => {
      const sequence = index + 1;
      const id = `${idPrefix}${String(sequence).padStart(5, "0")}`;
      return {
        id,
        roomId,
        userId: "user-ada",
        username: "Ada",
        ciphertext: `ciphertext-${sequence}`,
        nonce: `nonce-${sequence}`,
        type: "text" as const,
        // Equal timestamps exercise the timestamp/id part of the keyset cursor.
        timestampMs: 10_000 + Math.floor(index / 4),
        deletedAt: sequence % 11 === 0 ? new Date() : null,
      };
    });
    const insertBatchSize = 1_000;
    for (let start = 0; start < stored.length; start += insertBatchSize) {
      await db
        .insert(messagesTable)
        .values(stored.slice(start, start + insertBatchSize));
    }
    await pool.query("ANALYZE messages");

    const cursorSequence = 11_900;
    const cursor = stored[cursorSequence - 1]!;
    const explained = await pool.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlan }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id, ciphertext, nonce, user_id, username, timestamp_ms, type, system_content
       FROM messages
       WHERE room_id = $1
         AND deleted_at IS NULL
         AND (timestamp_ms > $2 OR (timestamp_ms = $2 AND id > $3))
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT 81`,
      [roomId, cursor.timestampMs, cursor.id],
    );
    const plan = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
    expect(plan).toBeDefined();
    expect(collectIndexNames(plan!)).toContain("messages_active_room_cursor_idx");

    const page = await loadEncryptedMessagesAfter(
      roomId,
      { id: cursor.id, timestamp: cursor.timestampMs },
      80,
    );
    const expected = stored
      .filter(
        (message) =>
          message.deletedAt === null &&
          (message.timestampMs > cursor.timestampMs ||
            (message.timestampMs === cursor.timestampMs && message.id > cursor.id)),
      )
      .sort(
        (left, right) =>
          left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
      )
      .slice(0, 80)
      .map((message) => message.id);
    expect(page.messages.map((message) => message.id)).toEqual(expected);
    expect(page.messages).toHaveLength(expected.length);
  });

  it("rejects a room after 24 hours without access and persists the expiry", async () => {
    const roomId = `inactive-room-${Date.now()}-${process.pid}`;
    roomIds.add(roomId);
    await db.insert(roomsTable).values({
      id: roomId,
      name: "Inactive room",
      createdBy: "user-ada",
      lastAccessedAt: new Date(Date.now() - ROOM_INACTIVITY_TIMEOUT_MS - 1),
    });

    runningServer = await startServer();
    const client = createRoomClient(runningServer.url);
    await waitForEvent(client, "connect");
    const error = waitForEvent<{ code: string }>(client, "error");
    client.emit("join-room", { roomId, createIfMissing: false });

    await expect(error).resolves.toMatchObject({ code: "ROOM_INACTIVE" });
    const [room] = await db
      .select({ isActive: roomsTable.isActive })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);
    expect(room?.isActive).toBe(false);
  });

  it("expires a room that is still resident in memory and refuses to revive it", async () => {
    const roomId = `occupied-expiry-${Date.now()}-${process.pid}`;
    roomIds.add(roomId);
    await db.insert(roomsTable).values({
      id: roomId,
      name: "Occupied room",
      createdBy: "user-ada",
    });

    runningServer = await startServer();
    const member = createRoomClient(runningServer.url);
    await waitForEvent(member, "connect");
    const joined = waitForEvent(member, "room-joined");
    member.emit("join-room", { roomId, createIfMissing: false });
    await expect(joined).resolves.toMatchObject({ roomId });

    // The room is now held in memory, so only an in-memory age check can close
    // it. Age the resident room past the window instead of mocking the clock,
    // which would also stall the Socket.IO transport this test depends on.
    const expiredAccess = Date.now() - ROOM_INACTIVITY_TIMEOUT_MS - 1;
    setRoomLastAccessedAtForTest(roomId, expiredAccess);

    // An action from the still-connected member must not refresh the window.
    const ignoredBroadcast = new Promise<boolean>((resolve) => {
      member.once("message", () => resolve(true));
      setTimeout(() => resolve(false), 250);
    });
    member.emit("message", {
      roomId,
      ciphertext: "ciphertext-after-expiry",
      nonce: "nonce-after-expiry",
    });
    await expect(ignoredBroadcast).resolves.toBe(false);

    const rejoinError = waitForEvent<{ code: string }>(member, "error");
    member.emit("join-room", { roomId, createIfMissing: false });
    await expect(rejoinError).resolves.toMatchObject({
      code: "ROOM_INACTIVE",
    });

    const [room] = await db
      .select({ isActive: roomsTable.isActive })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);
    expect(room?.isActive).toBe(false);
  });

  it("refreshes the inactivity window on a successful room join", async () => {
    const roomId = `accessed-room-${Date.now()}-${process.pid}`;
    roomIds.add(roomId);
    const previousAccess = new Date(
      Date.now() - ROOM_INACTIVITY_TIMEOUT_MS + 60_000,
    );
    await db.insert(roomsTable).values({
      id: roomId,
      name: "Recently accessed room",
      createdBy: "user-ada",
      lastAccessedAt: previousAccess,
    });

    runningServer = await startServer();
    const client = createRoomClient(runningServer.url);
    await waitForEvent(client, "connect");
    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId, createIfMissing: false });

    await expect(joined).resolves.toMatchObject({ roomId });
    let room: { lastAccessedAt: Date } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      [room] = await db
        .select({ lastAccessedAt: roomsTable.lastAccessedAt })
        .from(roomsTable)
        .where(eq(roomsTable.id, roomId))
        .limit(1);
      if (room && room.lastAccessedAt.getTime() > previousAccess.getTime()) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(room?.lastAccessedAt.getTime()).toBeGreaterThan(
      previousAccess.getTime(),
    );
  });

  it("recovers every active message in keyset order after restart and stops after revocation", async () => {
    const roomId = `db-recovery-${Date.now()}-${process.pid}`;
    roomIds.add(roomId);
    await db.insert(roomsTable).values({
      id: roomId,
      name: "Database recovery",
      createdBy: "user-ada",
    });

    const baseline = { id: "cursor-000", timestamp: 1_000 };
    const stored = Array.from({ length: 165 }, (_, index) => {
      const sequence = index + 1;
      const id = `message-${String(sequence).padStart(3, "0")}`;
      return {
        id,
        roomId,
        userId: "user-ada",
        username: "Ada",
        ciphertext: `ciphertext-${id}`,
        nonce: `nonce-${id}`,
        type: "text" as const,
        // Shared timestamps force the query to use the composite timestamp/id cursor.
        timestampMs: 1_001 + Math.floor(index / 3),
        deletedAt: sequence === 2 || sequence === 81 || sequence === 164
          ? new Date()
          : null,
      };
    });
    await db.insert(messagesTable).values(stored);

    runningServer = await startServer();
    await stopServer(runningServer);
    runningServer = null;
    resetSocketRoomStateForTest();
    runningServer = await startServer();

    const client = createRoomClient(runningServer.url);
    await waitForEvent(client, "connect");
    const joined = waitForEvent<{ replayGap: boolean }>(client, "room-joined");
    client.emit("join-room", {
      roomId,
      createIfMissing: false,
      lastSeenMessageId: baseline.id,
    });
    await expect(joined).resolves.toMatchObject({ replayGap: true });

    const recovered: string[] = [];
    let cursor = baseline;
    for (let pageNumber = 1; ; pageNumber += 1) {
      const page = await recoverPage(
        client,
        roomId,
        `recovery-${pageNumber}`,
        cursor,
      );
      recovered.push(...page.messages.map((message) => message.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    const expected = stored
      .filter((message) => message.deletedAt === null)
      .sort(
        (left, right) =>
          left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
      )
      .map((message) => message.id);
    expect(recovered).toEqual(expected);
    expect(recovered).toHaveLength(162);

    await db.insert(roomBansTable).values({
      id: `ban-${roomId}`,
      roomId,
      userId: "user-ben",
      bannedBy: "user-ada",
      isPermanent: true,
    });
    const recoveryError = waitForEvent<{ requestId: string; code: string }>(
      client,
      "message-recovery-error",
    );
    const unexpectedPage = vi.fn();
    client.on("message-recovery-page", unexpectedPage);
    client.emit("recover-messages", {
      requestId: "revoked-recovery",
      roomId,
      afterMessageId: baseline.id,
      afterTimestamp: baseline.timestamp,
    });
    await expect(recoveryError).resolves.toEqual({
      requestId: "revoked-recovery",
      code: "ROOM_BANNED",
    });
    expect(unexpectedPage).not.toHaveBeenCalled();

    const remainingDeletedRows = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.roomId, roomId),
          eq(messagesTable.id, "message-081"),
        ),
      );
    expect(remainingDeletedRows).toEqual([{ id: "message-081" }]);
  });
});