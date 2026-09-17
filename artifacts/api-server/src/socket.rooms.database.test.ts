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
import { loadEncryptedMessagesAfter } from "./lib/e2eePersistence.js";
import { resetSocketRoomStateForTest, setupSocketIO } from "./socket.js";

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