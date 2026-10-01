import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockLoadEncryptedMessages = vi.hoisted(() => vi.fn());
const mockLoadEncryptedSandboxState = vi.hoisted(() => vi.fn());
const mockGetPublicKey = vi.hoisted(() => vi.fn());
const mockGetRoomEnvelope = vi.hoisted(() => vi.fn());
const mockSaveEncryptedMessage = vi.hoisted(() => vi.fn());
const mockSaveEncryptedSandboxState = vi.hoisted(() => vi.fn());
const mockSaveRoomEnvelope = vi.hoisted(() => vi.fn());

const { roomsTable, roomBansTable, roomKickCooldownsTable, mockDb } =
  vi.hoisted(() => ({
    roomsTable: { id: "rooms.id" },
    roomBansTable: { id: "room-bans.id" },
    roomKickCooldownsTable: { expiresAt: "room-kick-cooldowns.expiresAt" },
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    },
  }));

vi.mock("@clerk/express", () => ({ verifyToken: vi.fn() }));
vi.mock("./../src/lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: () => false,
}));
vi.mock("@workspace/db", () => ({
  db: mockDb,
  roomBansTable,
  roomKickCooldownsTable,
  roomsTable,
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
}));
vi.mock("./../src/lib/e2eePersistence", () => ({
  getPublicKey: mockGetPublicKey,
  getPublicKeyRecord: vi.fn(),
  getRoomEnvelope: mockGetRoomEnvelope,
  keepActiveMessageIds: vi.fn(),
  loadDeletedMessageIdsAfter: vi.fn(),
  loadEncryptedMessages: mockLoadEncryptedMessages,
  loadEncryptedMessagesAfter: vi.fn(),
  loadEncryptedSandboxState: mockLoadEncryptedSandboxState,
  saveEncryptedMessage: mockSaveEncryptedMessage,
  saveEncryptedSandboxState: mockSaveEncryptedSandboxState,
  saveRoomEnvelope: mockSaveRoomEnvelope,
}));

import {
  createRoomAccessCapability,
  type RoomAccessPurpose,
} from "../src/lib/roomAccess.js";
import { ASSISTANT_REQUEST_COOLDOWN_MS } from "../src/lib/assistantLimits.js";
import { resetSocketRoomStateForTest, setupSocketIO } from "../src/socket.js";

const LIVE_ASSISTANT_TIMEOUT_MS = 30_000;
const roomId = `live-assistant-${Date.now()}`;
const requestId = "live-assistant-request";

interface AssistantChunkEvent {
  requestId: string;
  text: string;
}

interface AssistantDoneEvent {
  requestId: string;
  cancelled: boolean;
}

interface AssistantErrorEvent {
  requestId?: string;
  code?: string;
  message: string;
}

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
let client: ClientSocket;
const additionalClients: ClientSocket[] = [];

function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = LIVE_ASSISTANT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

function connectSandboxClient(): Promise<ClientSocket> {
  const token = createRoomAccessCapability({
    roomId,
    userId: "live-assistant-user",
    username: "Live assistant check",
    avatarEmoji: "🧪",
    purpose: "sandbox" satisfies RoomAccessPurpose,
  });
  const nextClient = createClient(serverUrl, {
    auth: { token },
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      nextClient.close();
      reject(new Error("Timed out connecting to the Socket.IO sandbox path."));
    }, LIVE_ASSISTANT_TIMEOUT_MS);
    nextClient.once("connect", () => {
      clearTimeout(timeout);
      resolve(nextClient);
    });
    nextClient.once("connect_error", (error) => {
      clearTimeout(timeout);
      nextClient.close();
      reject(new Error(`Socket.IO sandbox connection failed: ${error.message}`));
    });
  });
}

async function connectAndJoinSandboxClient(): Promise<ClientSocket> {
  const nextClient = await connectSandboxClient();
  const joined = waitForEvent(nextClient, "room-joined");
  nextClient.emit("join-room", { roomId, createIfMissing: false });
  await joined;
  return nextClient;
}

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SESSION_SECRET"] = "live-assistant-test-session-secret";

  mockGetAccountAccess.mockResolvedValue({ allowed: true });
  mockLoadEncryptedMessages.mockResolvedValue([]);
  mockLoadEncryptedSandboxState.mockResolvedValue(null);
  mockGetPublicKey.mockResolvedValue(null);
  mockGetRoomEnvelope.mockResolvedValue(null);

  mockDb.select.mockImplementation(() => ({
    from(table: unknown) {
      return {
        where() {
          return {
            limit: async () =>
              table === roomsTable
                ? [
                    {
                      name: "Live assistant sandbox",
                      createdBy: "live-assistant-user",
                      createdAt: new Date(),
                      lastAccessedAt: new Date(),
                      isActive: true,
                    },
                  ]
                : [],
          };
        },
      };
    },
  }));

  httpServer = createServer();
  socketServer = setupSocketIO(httpServer);
  httpServer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
  client = await connectAndJoinSandboxClient();
});

afterAll(async () => {
  client?.close();
  additionalClients.splice(0).forEach((additionalClient) => additionalClient.close());
  await new Promise((resolve) => setTimeout(resolve, 10));
  socketServer?.close();
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  resetSocketRoomStateForTest();
});

describe("live sandbox assistant integration", () => {
  it("streams a managed-model response through Socket.IO without persisting it", async () => {
    const chunks: AssistantChunkEvent[] = [];
    const errors: AssistantErrorEvent[] = [];
    client.on("assistant-chunk", (event: AssistantChunkEvent) => chunks.push(event));
    client.on("assistant-error", (event: AssistantErrorEvent) => errors.push(event));
    const done = waitForEvent<AssistantDoneEvent>(client, "assistant-done");

    client.emit("assistant-request", {
      requestId,
      roomId,
      prompt: "Reply with exactly one short word: OK.",
      files: {
        html: "<main>Live check</main>",
        css: "main { color: black; }",
        js: "",
      },
      disclosureAcknowledged: true,
    });

    await expect(done).resolves.toEqual({
      requestId,
      cancelled: false,
    });

    expect(errors).toEqual([]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.requestId === requestId)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("").trim()).not.toBe("");
    expect(mockSaveEncryptedMessage).not.toHaveBeenCalled();
    expect(mockSaveEncryptedSandboxState).not.toHaveBeenCalled();
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();
  });

  it("cancels a provider-backed response without late chunks or completion", async () => {
    const cancellationClient = await connectAndJoinSandboxClient();
    additionalClients.push(cancellationClient);

    const chunks: AssistantChunkEvent[] = [];
    const doneEvents: AssistantDoneEvent[] = [];
    const errors: AssistantErrorEvent[] = [];
    cancellationClient.on("assistant-chunk", (event: AssistantChunkEvent) => {
      chunks.push(event);
    });
    cancellationClient.on("assistant-done", (event: AssistantDoneEvent) => {
      doneEvents.push(event);
    });
    cancellationClient.on("assistant-error", (event: AssistantErrorEvent) => {
      errors.push(event);
    });

    const requestId = "live-assistant-cancel-request";
    const firstChunk = waitForEvent<AssistantChunkEvent>(
      cancellationClient,
      "assistant-chunk",
    );
    const done = waitForEvent<AssistantDoneEvent>(
      cancellationClient,
      "assistant-done",
    );

    cancellationClient.emit("assistant-request", {
      requestId,
      roomId,
      prompt:
        "Begin a long explanation of practical CSS layout improvements for this sandbox and continue with many concrete suggestions.",
      files: {
        html: "<main>Live cancellation check</main>",
        css: "main { color: black; }",
        js: "",
      },
      disclosureAcknowledged: true,
    });

    await firstChunk;
    cancellationClient.emit("assistant-cancel", { requestId, roomId });

    await expect(done).resolves.toEqual({
      requestId,
      cancelled: true,
    });

    const chunksAtCancellation = chunks.length;
    const doneEventsAtCancellation = doneEvents.length;
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(errors).toEqual([]);
    expect(chunks.length).toBe(chunksAtCancellation);
    expect(doneEvents.length).toBe(doneEventsAtCancellation);
    expect(doneEvents).toEqual([{ requestId, cancelled: true }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.requestId === requestId)).toBe(true);
    expect(mockSaveEncryptedMessage).not.toHaveBeenCalled();
    expect(mockSaveEncryptedSandboxState).not.toHaveBeenCalled();
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();

    await new Promise((resolve) =>
      setTimeout(resolve, ASSISTANT_REQUEST_COOLDOWN_MS),
    );

    const followUpRequestId = "live-assistant-after-cancel-request";
    const followUpDone = waitForEvent<AssistantDoneEvent>(
      cancellationClient,
      "assistant-done",
    );
    cancellationClient.emit("assistant-request", {
      requestId: followUpRequestId,
      roomId,
      prompt: "Reply with exactly one short word: RECOVERED.",
      files: {
        html: "<main>Live recovery check</main>",
        css: "main { color: black; }",
        js: "",
      },
      disclosureAcknowledged: true,
    });

    await expect(followUpDone).resolves.toEqual({
      requestId: followUpRequestId,
      cancelled: false,
    });

    const followUpChunks = chunks.filter(
      (chunk) => chunk.requestId === followUpRequestId,
    );
    expect(
      chunks.filter((chunk) => chunk.requestId === requestId),
    ).toHaveLength(chunksAtCancellation);
    expect(followUpChunks.length).toBeGreaterThan(0);
    expect(followUpChunks.map((chunk) => chunk.text).join("").trim()).not.toBe("");
    expect(chunks.every((chunk) =>
      [requestId, followUpRequestId].includes(chunk.requestId),
    )).toBe(true);
    expect(doneEvents).toEqual([
      { requestId, cancelled: true },
      { requestId: followUpRequestId, cancelled: false },
    ]);
    expect(errors).toEqual([]);
    expect(mockSaveEncryptedMessage).not.toHaveBeenCalled();
    expect(mockSaveEncryptedSandboxState).not.toHaveBeenCalled();
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();
  });

  it("cancels a provider-backed response immediately before the first chunk", async () => {
    const cancellationClient = await connectAndJoinSandboxClient();
    additionalClients.push(cancellationClient);

    const chunks: AssistantChunkEvent[] = [];
    const doneEvents: AssistantDoneEvent[] = [];
    const errors: AssistantErrorEvent[] = [];
    cancellationClient.on("assistant-chunk", (event: AssistantChunkEvent) => {
      chunks.push(event);
    });
    cancellationClient.on("assistant-done", (event: AssistantDoneEvent) => {
      doneEvents.push(event);
    });
    cancellationClient.on("assistant-error", (event: AssistantErrorEvent) => {
      errors.push(event);
    });

    const requestId = "live-assistant-immediate-cancel";
    const done = waitForEvent<AssistantDoneEvent>(
      cancellationClient,
      "assistant-done",
    );

    cancellationClient.emit("assistant-request", {
      requestId,
      roomId,
      prompt:
        "Begin a long explanation of practical CSS layout improvements for this sandbox and continue with many concrete suggestions.",
      files: {
        html: "<main>Live immediate cancellation check</main>",
        css: "main { color: black; }",
        js: "",
      },
      disclosureAcknowledged: true,
    });
    cancellationClient.emit("assistant-cancel", { requestId, roomId });

    await expect(done).resolves.toEqual({
      requestId,
      cancelled: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(errors).toEqual([]);
    expect(chunks).toEqual([]);
    expect(doneEvents).toEqual([{ requestId, cancelled: true }]);
    expect(mockSaveEncryptedMessage).not.toHaveBeenCalled();
    expect(mockSaveEncryptedSandboxState).not.toHaveBeenCalled();
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();
  });
});