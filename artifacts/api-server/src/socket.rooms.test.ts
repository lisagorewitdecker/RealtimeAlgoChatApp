import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import nacl from "tweetnacl";

const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockIsConfiguredAdmin = vi.hoisted(() => vi.fn());
const mockGetPublicKey = vi.hoisted(() => vi.fn());
const mockGetPublicKeyRecord = vi.hoisted(() => vi.fn());
const mockGetRoomEnvelope = vi.hoisted(() => vi.fn());
const mockLoadEncryptedMessages = vi.hoisted(() => vi.fn());
const mockLoadEncryptedMessagesAfter = vi.hoisted(() => vi.fn());
const mockLoadDeletedMessageIdsAfter = vi.hoisted(() => vi.fn());
const mockKeepActiveMessageIds = vi.hoisted(() => vi.fn());
const mockLoadEncryptedSandboxState = vi.hoisted(() => vi.fn());
const mockSaveEncryptedMessage = vi.hoisted(() => vi.fn());
const mockSaveEncryptedSandboxState = vi.hoisted(() => vi.fn());
const mockSaveRoomEnvelope = vi.hoisted(() => vi.fn());
const mockStreamSandboxAssistant = vi.hoisted(() => vi.fn());

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

vi.mock("./lib/e2eePersistence", () => ({
  getPublicKey: mockGetPublicKey,
  getPublicKeyRecord: mockGetPublicKeyRecord,
  getRoomEnvelope: mockGetRoomEnvelope,
  loadEncryptedMessages: mockLoadEncryptedMessages,
  loadEncryptedMessagesAfter: mockLoadEncryptedMessagesAfter,
  loadDeletedMessageIdsAfter: mockLoadDeletedMessageIdsAfter,
  keepActiveMessageIds: mockKeepActiveMessageIds,
  loadEncryptedSandboxState: mockLoadEncryptedSandboxState,
  saveEncryptedMessage: mockSaveEncryptedMessage,
  saveEncryptedSandboxState: mockSaveEncryptedSandboxState,
  registerPublicKey: vi.fn(),
  saveRoomEnvelope: mockSaveRoomEnvelope,
}));

vi.mock("./lib/sandboxAssistant", () => ({
  streamSandboxAssistant: mockStreamSandboxAssistant,
}));

import {
  disconnectBannedUser,
  getRooms,
  kickRoomMember,
  setRoomActiveForModeration,
  setupSocketIO,
} from "./socket.js";
import { createRoomAccessCapability } from "./lib/roomAccess.js";

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  process.env["SESSION_SECRET"] = "socket-rooms-test-session-secret";
  mockVerifyToken.mockReset().mockImplementation(async (token: string) => {
    if (token === "token-ada") return { sub: "user-ada" };
    if (token === "token-ben") return { sub: "user-ben" };
    if (token === "token-cara") return { sub: "user-cara" };
    if (token === "token-dana") return { sub: "user-dana" };
    throw new Error("Invalid session");
  });
  mockGetAccountProfile.mockReset().mockImplementation(async (userId: string) => {
    if (userId === "user-ada") return { username: "Ada", avatarEmoji: "👩‍💻" };
    if (userId === "user-cara") return { username: "Cara", avatarEmoji: "🐱" };
    if (userId === "user-dana") return { username: "Dana", avatarEmoji: "🐶" };
    return { username: "Ben", avatarEmoji: "🦊" };
  });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockIsConfiguredAdmin.mockReset().mockReturnValue(false);
  mockGetPublicKey.mockReset().mockResolvedValue(null);
  // Unless a test records a displaced key, the record mirrors the current key.
  mockGetPublicKeyRecord.mockReset().mockImplementation(async (userId: string) => ({
    publicKey: await mockGetPublicKey(userId),
    previousPublicKey: null,
  }));
  mockGetRoomEnvelope.mockReset().mockResolvedValue(null);
  mockLoadEncryptedMessages.mockReset().mockResolvedValue([]);
  mockLoadEncryptedMessagesAfter.mockReset().mockResolvedValue({
    messages: [],
    hasMore: false,
  });
  mockLoadDeletedMessageIdsAfter.mockReset().mockResolvedValue({
    tombstones: [],
    hasMore: false,
  });
  mockKeepActiveMessageIds.mockReset().mockImplementation(
    async (_roomId: string, ids: string[]) => new Set(ids),
  );
  mockLoadEncryptedSandboxState.mockReset().mockResolvedValue(null);
  mockSaveEncryptedMessage.mockReset().mockResolvedValue(undefined);
  mockSaveEncryptedSandboxState.mockReset().mockResolvedValue(undefined);
  mockSaveRoomEnvelope.mockReset().mockResolvedValue(undefined);
  mockStreamSandboxAssistant.mockReset();

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

function createRoomClient(token?: string, username = "Member") {
  const client = createClient(serverUrl, {
    auth: token
      ? { token, username, avatarEmoji: "🧑‍💻" }
      : { username, avatarEmoji: "🧑‍💻" },
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  clients.push(client);
  return client;
}

async function createSandboxClient(roomId: string) {
  const token = createRoomAccessCapability({
    roomId,
    userId: "user-ada",
    username: "Ada",
    avatarEmoji: "👩‍💻",
    purpose: "sandbox",
  });
  const client = createRoomClient(token);
  await waitForEvent(client, "connect");
  const joined = waitForEvent(client, "room-joined");
  client.emit("join-room", { roomId });
  await joined;
  return client;
}

const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decodeBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

function waitForEvent<T>(socket: ClientSocket, event: string) {
  return new Promise<T>((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

async function waitFor(
  assertion: () => void,
  options: { attempts?: number; delayMs?: number } = {},
) {
  let lastError: unknown;
  const attempts = options.attempts ?? 25;
  const delayMs = options.delayMs ?? 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function expectNoEvent(
  socket: ClientSocket,
  event: string,
  action: () => void,
) {
  let received = false;
  socket.once(event, () => {
    received = true;
  });
  action();
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(received).toBe(false);
}

describe("room Socket.IO lifecycle", () => {
  it("abandons disconnected assistant work and settles the next request after reconnect", async () => {
    const roomId = `assistant-abandoned-${Date.now()}`;
    const firstClient = await createSandboxClient(roomId);
    const firstChunks: Array<{ requestId: string; text: string }> = [];
    const firstErrors: unknown[] = [];
    const firstDoneEvents: Array<{ requestId: string; cancelled: boolean }> = [];
    firstClient.on("assistant-chunk", (event) => firstChunks.push(event));
    firstClient.on("assistant-error", (event) => firstErrors.push(event));
    firstClient.on("assistant-done", (event) => firstDoneEvents.push(event));

    let firstSignal: AbortSignal | undefined;
    let firstOnText: ((text: string) => void) | undefined;
    let resolveFirstStream: (() => void) | undefined;
    mockStreamSandboxAssistant.mockImplementationOnce(
      ({ signal, onText }: {
        signal: AbortSignal;
        onText: (text: string) => void;
      }) =>
        new Promise<void>((resolve) => {
          firstSignal = signal;
          firstOnText = onText;
          resolveFirstStream = resolve;
        }),
    );

    firstClient.emit("assistant-request", {
      requestId: "assistant-abandoned-request",
      roomId,
      prompt: "Explain the layout.",
      files: { html: "<button>Go</button>", css: "", js: "" },
      disclosureAcknowledged: true,
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    const disconnected = waitForEvent(firstClient, "disconnect");
    firstClient.disconnect();
    await disconnected;
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(firstDoneEvents).toEqual([]);

    firstOnText?.("late chunk");
    resolveFirstStream?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstChunks).toEqual([]);
    expect(firstErrors).toEqual([]);

    const secondClient = await createSandboxClient(roomId);
    const secondChunks: Array<{ requestId: string; text: string }> = [];
    const secondErrors: unknown[] = [];
    secondClient.on("assistant-chunk", (event) => secondChunks.push(event));
    secondClient.on("assistant-error", (event) => secondErrors.push(event));
    const secondDone = waitForEvent<{
      requestId: string;
      cancelled: boolean;
    }>(secondClient, "assistant-done");
    mockStreamSandboxAssistant.mockImplementationOnce(
      async ({ onText }: { onText: (text: string) => void }) => {
        onText("fresh reply");
      },
    );
    secondClient.emit("assistant-request", {
      requestId: "assistant-follow-up-request",
      roomId,
      prompt: "Explain the layout again.",
      files: { html: "<button>Go</button>", css: "", js: "" },
      disclosureAcknowledged: true,
    });

    await expect(secondDone).resolves.toEqual({
      requestId: "assistant-follow-up-request",
      cancelled: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(secondChunks).toEqual([
      { requestId: "assistant-follow-up-request", text: "fresh reply" },
    ]);
    expect(secondErrors).toEqual([]);
    expect(mockStreamSandboxAssistant).toHaveBeenCalledTimes(2);
  });

  it("lists rooms only while they remain active", async () => {
    const roomId = `active-room-${Date.now()}`;
    const client = createRoomClient("token-ada");
    await waitForEvent(client, "connect");

    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId });
    await joined;
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 1 }),
    ]);

    setRoomActiveForModeration(roomId, false);
    expect(getRooms()).toEqual([]);

    setRoomActiveForModeration(roomId, true);
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 1 }),
    ]);
  });

  it("relays only encrypted chat and sandbox payloads and delivers key envelopes", async () => {
    const roomId = `encrypted-room-${Date.now()}`;
    mockGetPublicKey.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? "sender-key" : "recipient-key",
    );
    const ada = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    await Promise.all([waitForEvent(ada, "connect"), waitForEvent(ben, "connect")]);

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId });
    await adaJoined;
    const benJoined = waitForEvent<{
      users: Array<{ userId: string; publicKey: string | null }>;
    }>(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await expect(benJoined).resolves.toMatchObject({
      users: [
        { userId: "user-ada", publicKey: "sender-key" },
        { userId: "user-ben", publicKey: "recipient-key" },
      ],
    });

    await expectNoEvent(ben, "message", () => {
      ada.emit("message", { roomId, content: "server-readable secret" });
    });

    const encryptedMessage = waitForEvent<{
      ciphertext: string;
      nonce: string;
      content?: string;
    }>(ben, "message");
    ada.emit("message", {
      roomId,
      ciphertext: "Y2lwaGVydGV4dA==",
      nonce: "bm9uY2U=",
    });
    await expect(encryptedMessage).resolves.toMatchObject({
      ciphertext: "Y2lwaGVydGV4dA==",
      nonce: "bm9uY2U=",
    });
    expect((await encryptedMessage).content).toBeUndefined();
    await waitFor(() => expect(mockSaveEncryptedMessage).toHaveBeenCalled());

    mockSaveRoomEnvelope.mockClear();
    ada.emit("room-key-envelope", {
      roomId,
      targetUserId: "user-not-in-room",
      senderPublicKey: "sender-key",
      ciphertext: "ZW52ZWxvcGU=",
      nonce: "ZW52ZWxvcGUtbm9uY2U=",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();

    const deliveredEnvelope = waitForEvent<{
      roomId: string;
      targetUserId: string;
      ciphertext: string;
      nonce: string;
    }>(ben, "room-key-envelope");
    ada.emit("room-key-envelope", {
      roomId,
      targetUserId: "user-ben",
      senderPublicKey: "sender-key",
      ciphertext: "ZW52ZWxvcGU=",
      nonce: "ZW52ZWxvcGUtbm9uY2U=",
    });
    await expect(deliveredEnvelope).resolves.toMatchObject({
      roomId,
      ciphertext: "ZW52ZWxvcGU=",
      nonce: "ZW52ZWxvcGUtbm9uY2U=",
    });
    await waitFor(() => expect(mockSaveRoomEnvelope).toHaveBeenCalled());

    mockSaveRoomEnvelope.mockClear();
    await expectNoEvent(ada, "room-key-envelope", () => {
      ben.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ada",
        senderPublicKey: "recipient-key",
        ciphertext: "YXR0YWNrLWVudmVsb3Bl",
        nonce: "YXR0YWNrLW5vbmNl",
      });
    });
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();
  });

  it("lets the creator deliver and persist a fresh envelope after a member resets their device key", async () => {
    const roomId = `device-reset-${Date.now()}`;
    let benKey = "ben-old-key";
    mockGetPublicKey.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? "ada-key" : benKey,
    );
    const ada = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    await Promise.all([waitForEvent(ada, "connect"), waitForEvent(ben, "connect")]);

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId });
    await adaJoined;
    const benJoined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await benJoined;

    // Ben resets his device key: the client leaves, registers the new key,
    // and re-joins only afterwards.
    const benLeft = waitForEvent<{ userId: string }>(ada, "user-left");
    ben.emit("leave-room", { roomId });
    await expect(benLeft).resolves.toMatchObject({ userId: "user-ben" });
    benKey = "ben-new-key";

    const benRejoinedForAda = waitForEvent<{ userId: string; publicKey: string | null }>(
      ada,
      "user-joined",
    );
    const benRejoined = waitForEvent<{
      users: Array<{ userId: string; publicKey: string | null }>;
    }>(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await expect(benRejoinedForAda).resolves.toMatchObject({
      userId: "user-ben",
      publicKey: "ben-new-key",
    });
    await expect(benRejoined).resolves.toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "user-ben", publicKey: "ben-new-key" }),
      ]),
    });

    mockSaveRoomEnvelope.mockClear();
    const freshEnvelope = waitForEvent<{
      roomId: string;
      ciphertext: string;
      nonce: string;
      senderPublicKey: string;
    }>(ben, "room-key-envelope");
    ada.emit("room-key-envelope", {
      roomId,
      targetUserId: "user-ben",
      senderPublicKey: "ada-key",
      ciphertext: "ZnJlc2gtZW52ZWxvcGU=",
      nonce: "ZnJlc2gtbm9uY2U=",
    });
    await expect(freshEnvelope).resolves.toEqual({
      roomId,
      ciphertext: "ZnJlc2gtZW52ZWxvcGU=",
      nonce: "ZnJlc2gtbm9uY2U=",
      senderPublicKey: "ada-key",
    });
    await waitFor(() =>
      expect(mockSaveRoomEnvelope).toHaveBeenCalledWith({
        roomId,
        userId: "user-ben",
        ciphertext: "ZnJlc2gtZW52ZWxvcGU=",
        nonce: "ZnJlc2gtbm9uY2U=",
        senderPublicKey: "ada-key",
      }),
    );
  });

  it("tells the creator about a member's new device key while another session of theirs stays in the room", async () => {
    const roomId = `device-reset-multi-${Date.now()}`;
    let benKey = "ben-old-key";
    mockGetPublicKey.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? "ada-key" : benKey,
    );
    const ada = createRoomClient("token-ada");
    const benPhone = createRoomClient("token-ben");
    const benLaptop = createRoomClient("token-ben");
    await Promise.all([
      waitForEvent(ada, "connect"),
      waitForEvent(benPhone, "connect"),
      waitForEvent(benLaptop, "connect"),
    ]);

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId });
    await adaJoined;
    const benPhoneJoined = waitForEvent(benPhone, "room-joined");
    const benJoinedForAda = waitForEvent<{ userId: string; publicKey: string | null }>(
      ada,
      "user-joined",
    );
    benPhone.emit("join-room", { roomId, createIfMissing: false });
    await benPhoneJoined;
    await expect(benJoinedForAda).resolves.toMatchObject({
      userId: "user-ben",
      publicKey: "ben-old-key",
    });

    // A second session of the same account joins with the same key: the
    // account is already present, so peers hear nothing.
    const benLaptopJoined = waitForEvent(benLaptop, "room-joined");
    await expectNoEvent(ada, "user-joined", () => {
      benLaptop.emit("join-room", { roomId, createIfMissing: false });
    });
    await benLaptopJoined;

    // The phone resets its device key and re-joins. The laptop keeps the
    // account's presence alive, so no user-left / user-joined pair fires.
    benKey = "ben-new-key";
    await expectNoEvent(ada, "user-left", () => {
      benPhone.emit("leave-room", { roomId });
    });
    const keyChangedForAda = waitForEvent<{
      roomId: string;
      userId: string;
      username: string;
      publicKey: string;
    }>(ada, "user-key-changed");
    const benPhoneRejoined = waitForEvent<{
      users: Array<{ userId: string; publicKey: string | null }>;
    }>(benPhone, "room-joined");
    await expectNoEvent(ada, "user-joined", () => {
      benPhone.emit("join-room", { roomId, createIfMissing: false });
    });
    await expect(keyChangedForAda).resolves.toEqual({
      roomId,
      userId: "user-ben",
      username: "Ben",
      publicKey: "ben-new-key",
    });
    await expect(benPhoneRejoined).resolves.toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "user-ben", publicKey: "ben-new-key" }),
      ]),
    });

    // The creator answers with an envelope for the new key; it is persisted
    // and reaches every session of the account.
    mockSaveRoomEnvelope.mockClear();
    const phoneEnvelope = waitForEvent<{ senderPublicKey: string }>(
      benPhone,
      "room-key-envelope",
    );
    const laptopEnvelope = waitForEvent<{ senderPublicKey: string }>(
      benLaptop,
      "room-key-envelope",
    );
    ada.emit("room-key-envelope", {
      roomId,
      targetUserId: "user-ben",
      senderPublicKey: "ada-key",
      ciphertext: "ZnJlc2gtZW52ZWxvcGU=",
      nonce: "ZnJlc2gtbm9uY2U=",
    });
    await expect(phoneEnvelope).resolves.toMatchObject({ senderPublicKey: "ada-key" });
    await expect(laptopEnvelope).resolves.toMatchObject({ senderPublicKey: "ada-key" });
    await waitFor(() =>
      expect(mockSaveRoomEnvelope).toHaveBeenCalledWith({
        roomId,
        userId: "user-ben",
        ciphertext: "ZnJlc2gtZW52ZWxvcGU=",
        nonce: "ZnJlc2gtbm9uY2U=",
        senderPublicKey: "ada-key",
      }),
    );

    // A re-join with an unchanged key stays silent.
    const benLaptopRejoined = waitForEvent(benLaptop, "room-joined");
    await expectNoEvent(ada, "user-key-changed", () => {
      benLaptop.emit("join-room", { roomId, createIfMissing: false });
    });
    await benLaptopRejoined;
  });

  it("lets a superseded creator session hand its room key to the account's new device key", async () => {
    // Ada created the room on her old phone, which holds the room key. She
    // takes over the registration from a fresh phone that has no room key.
    const roomId = `creator-handover-${Date.now()}`;
    const oldPhoneKeys = nacl.box.keyPair();
    const newPhoneKeys = nacl.box.keyPair();
    const oldKey = encodeBase64(oldPhoneKeys.publicKey);
    const newKey = encodeBase64(newPhoneKeys.publicKey);
    const roomKey = nacl.randomBytes(nacl.secretbox.keyLength);
    let adaRecord = { publicKey: oldKey, previousPublicKey: null as string | null };
    mockGetPublicKey.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? adaRecord.publicKey : "ben-key",
    );
    mockGetPublicKeyRecord.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? adaRecord : { publicKey: "ben-key", previousPublicKey: null },
    );

    const oldPhone = createRoomClient("token-ada");
    const newPhone = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    await Promise.all([
      waitForEvent(oldPhone, "connect"),
      waitForEvent(newPhone, "connect"),
      waitForEvent(ben, "connect"),
    ]);
    const oldPhoneJoined = waitForEvent(oldPhone, "room-joined");
    oldPhone.emit("join-room", { roomId });
    await oldPhoneJoined;
    const benJoined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await benJoined;

    // The fresh phone registers (compare-and-set records the displaced key)
    // and joins; the old phone learns about the account's new key.
    adaRecord = { publicKey: newKey, previousPublicKey: oldKey };
    const keyChangedForOldPhone = waitForEvent<{ userId: string; publicKey: string }>(
      oldPhone,
      "user-key-changed",
    );
    const newPhoneJoined = waitForEvent<{ keyEnvelope: unknown }>(newPhone, "room-joined");
    newPhone.emit("join-room", { roomId, createIfMissing: false });
    await expect(newPhoneJoined).resolves.toMatchObject({ keyEnvelope: null });
    await expect(keyChangedForOldPhone).resolves.toEqual(
      expect.objectContaining({ userId: "user-ada", publicKey: newKey }),
    );

    // The old phone is no longer the account's key authority for others: an
    // envelope for Ben signed with the displaced key is dropped.
    const nonceForBen = nacl.randomBytes(nacl.box.nonceLength);
    await expectNoEvent(ben, "room-key-envelope", () => {
      oldPhone.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ben",
        senderPublicKey: oldKey,
        ciphertext: encodeBase64(
          nacl.box(roomKey, nonceForBen, nacl.box.keyPair().publicKey, oldPhoneKeys.secretKey),
        ),
        nonce: encodeBase64(nonceForBen),
      });
    });
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();

    // A self-targeted handover under the displaced key is persisted and
    // reaches the account's other session, never back to the sender.
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = encodeBase64(
      nacl.box(roomKey, nonce, newPhoneKeys.publicKey, oldPhoneKeys.secretKey),
    );
    const envelopeForNewPhone = waitForEvent<{
      roomId: string;
      ciphertext: string;
      nonce: string;
      senderPublicKey: string;
    }>(newPhone, "room-key-envelope");
    await expectNoEvent(oldPhone, "room-key-envelope", () => {
      oldPhone.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ada",
        senderPublicKey: oldKey,
        ciphertext,
        nonce: encodeBase64(nonce),
      });
    });
    const envelope = await envelopeForNewPhone;
    expect(envelope).toEqual({ roomId, ciphertext, nonce: encodeBase64(nonce), senderPublicKey: oldKey });
    const recovered = nacl.box.open(
      decodeBase64(envelope.ciphertext),
      decodeBase64(envelope.nonce),
      decodeBase64(envelope.senderPublicKey),
      newPhoneKeys.secretKey,
    );
    expect(recovered).toEqual(roomKey);
    await waitFor(() =>
      expect(mockSaveRoomEnvelope).toHaveBeenCalledWith({
        roomId,
        userId: "user-ada",
        ciphertext,
        nonce: encodeBase64(nonce),
        senderPublicKey: oldKey,
      }),
    );

    // Only the key the registry recorded as displaced may hand over: a key
    // the account never held, or one displaced by an even later reset, is
    // dropped. So is a non-creator's self-handover.
    mockSaveRoomEnvelope.mockClear();
    await expectNoEvent(newPhone, "room-key-envelope", () => {
      oldPhone.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ada",
        senderPublicKey: encodeBase64(nacl.box.keyPair().publicKey),
        ciphertext,
        nonce: encodeBase64(nonce),
      });
    });
    adaRecord = { publicKey: encodeBase64(nacl.box.keyPair().publicKey), previousPublicKey: newKey };
    await expectNoEvent(newPhone, "room-key-envelope", () => {
      oldPhone.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ada",
        senderPublicKey: oldKey,
        ciphertext,
        nonce: encodeBase64(nonce),
      });
    });
    const benLaptop = createRoomClient("token-ben");
    await waitForEvent(benLaptop, "connect");
    const benLaptopJoined = waitForEvent(benLaptop, "room-joined");
    benLaptop.emit("join-room", { roomId, createIfMissing: false });
    await benLaptopJoined;
    mockGetPublicKeyRecord.mockImplementation(async (userId: string) =>
      userId === "user-ada" ? adaRecord : { publicKey: "ben-new-key", previousPublicKey: "ben-key" },
    );
    await expectNoEvent(benLaptop, "room-key-envelope", () => {
      ben.emit("room-key-envelope", {
        roomId,
        targetUserId: "user-ben",
        senderPublicKey: "ben-key",
        ciphertext,
        nonce: encodeBase64(nonce),
      });
    });
    expect(mockSaveRoomEnvelope).not.toHaveBeenCalled();
  });

  it("restores only the joining account's stored room-key envelope", async () => {
    const roomId = `envelope-restore-${Date.now()}`;
    mockGetRoomEnvelope.mockImplementation(
      async (requestedRoomId: string, userId: string) =>
        requestedRoomId === roomId && userId === "user-ben"
          ? {
              ciphertext: "stored-envelope",
              nonce: "stored-nonce",
              senderPublicKey: "sender-key",
            }
          : null,
    );
    const ada = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    await Promise.all([waitForEvent(ada, "connect"), waitForEvent(ben, "connect")]);

    const adaJoined = waitForEvent<{ keyEnvelope: unknown }>(ada, "room-joined");
    ada.emit("join-room", { roomId });
    await expect(adaJoined).resolves.toMatchObject({ keyEnvelope: null });

    const benJoined = waitForEvent<{ keyEnvelope: unknown }>(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await expect(benJoined).resolves.toMatchObject({
      keyEnvelope: {
        ciphertext: "stored-envelope",
        nonce: "stored-nonce",
        senderPublicKey: "sender-key",
      },
    });
    expect(mockGetRoomEnvelope).toHaveBeenCalledWith(roomId, "user-ben");
  });

  it("pages persisted missed messages when the in-memory cursor is unavailable", async () => {
    const roomId = `recovery-restart-${Date.now()}`;
    const persisted = (id: string, timestamp: number) => ({
      id,
      ciphertext: `ciphertext-${id}`,
      nonce: `nonce-${id}`,
      userId: "user-ada",
      username: "Ada",
      timestamp,
      type: "text" as const,
      systemContent: null,
    });
    mockLoadEncryptedMessagesAfter
      .mockResolvedValueOnce({
        messages: [persisted("missed-1", 2)],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        messages: [persisted("missed-2", 3)],
        hasMore: false,
      });
    const client = createRoomClient("token-ben");
    await waitForEvent(client, "connect");
    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId });
    await joined;

    const firstPage = waitForEvent<{
      messages: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: { id: string; timestamp: number };
    }>(client, "message-recovery-page");
    client.emit("recover-messages", {
      requestId: "page-1",
      roomId,
      afterMessageId: "known-before-restart",
      afterTimestamp: 1,
      deletedAfter: 0,
    });
    await expect(firstPage).resolves.toMatchObject({
      messages: [{ id: "missed-1" }],
      hasMore: true,
      nextCursor: { id: "missed-1", timestamp: 2 },
    });

    const secondPage = waitForEvent<{
      messages: Array<{ id: string }>;
      hasMore: boolean;
    }>(client, "message-recovery-page");
    client.emit("recover-messages", {
      requestId: "page-2",
      roomId,
      afterMessageId: "missed-1",
      afterTimestamp: 2,
      deletedAfter: 0,
    });
    await expect(secondPage).resolves.toMatchObject({
      messages: [{ id: "missed-2" }],
      hasMore: false,
    });
    expect(mockLoadEncryptedMessagesAfter).toHaveBeenNthCalledWith(
      1,
      roomId,
      { id: "known-before-restart", timestamp: 1 },
      80,
    );
    expect(mockLoadEncryptedMessagesAfter).toHaveBeenNthCalledWith(
      2,
      roomId,
      { id: "missed-1", timestamp: 2 },
      80,
    );
  });

  it("returns bounded deletion tombstones while recovering missed messages", async () => {
    const roomId = `recovery-deletions-${Date.now()}`;
    mockLoadDeletedMessageIdsAfter.mockResolvedValueOnce({
      tombstones: [{ id: "deleted-while-offline", deletedAt: 25 }],
      hasMore: true,
    });
    const client = createRoomClient("token-ben");
    await waitForEvent(client, "connect");
    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId });
    await joined;

    const page = waitForEvent<{
      deletedMessageIds: string[];
      hasMore: boolean;
      nextDeletionCursor: { id: string; deletedAt: number };
    }>(client, "message-recovery-page");
    client.emit("recover-messages", {
      requestId: "deletion-page",
      roomId,
      afterMessageId: "known",
      afterTimestamp: 10,
      deletedAfter: 20,
      deletedAfterId: "prior-deletion",
    });

    await expect(page).resolves.toMatchObject({
      deletedMessageIds: ["deleted-while-offline"],
      hasMore: true,
      nextDeletionCursor: { id: "deleted-while-offline", deletedAt: 25 },
    });
    expect(mockLoadDeletedMessageIdsAfter).toHaveBeenCalledWith(
      roomId,
      { id: "prior-deletion", deletedAt: 20 },
      80,
    );
  });

  it("keeps legacy message recovery working without deletion cursor fields", async () => {
    const roomId = `legacy-recovery-${Date.now()}`;
    const client = createRoomClient("token-ben");
    await waitForEvent(client, "connect");
    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId });
    await joined;

    const page = waitForEvent<{ messages: unknown[] }>(
      client,
      "message-recovery-page",
    );
    client.emit("recover-messages", {
      requestId: "legacy-page",
      roomId,
      afterMessageId: "known",
      afterTimestamp: 10,
    });

    await expect(page).resolves.toMatchObject({ messages: [] });
    expect(mockLoadEncryptedMessagesAfter).toHaveBeenCalledWith(
      roomId,
      { id: "known", timestamp: 10 },
      80,
    );
  });

  it("removes rows deleted during cold room hydration before replaying them", async () => {
    const roomId = `cold-delete-race-${Date.now()}`;
    mockLoadEncryptedMessages.mockResolvedValueOnce([
      {
        id: "stale-hydrated-message",
        ciphertext: "ciphertext",
        nonce: "nonce",
        userId: "user-ada",
        username: "Ada",
        timestamp: 10,
        type: "text",
        systemContent: null,
      },
    ]);
    mockKeepActiveMessageIds.mockResolvedValueOnce(new Set());
    const client = createRoomClient("token-ben");
    await waitForEvent(client, "connect");
    const joined = waitForEvent<{ messages: Array<{ id: string }> }>(
      client,
      "room-joined",
    );
    client.emit("join-room", { roomId });

    await expect(joined).resolves.toMatchObject({ messages: [] });
    expect(mockKeepActiveMessageIds).toHaveBeenCalledWith(roomId, [
      "stale-hydrated-message",
    ]);
  });

  it("preserves a message appended while cold hydration is being rechecked", async () => {
    const roomId = `cold-recheck-append-${Date.now()}`;
    mockLoadEncryptedMessages.mockResolvedValueOnce([
      {
        id: "checked-message",
        ciphertext: "ciphertext",
        nonce: "nonce",
        userId: "user-ada",
        username: "Ada",
        timestamp: 10,
        type: "text",
        systemContent: null,
      },
    ]);
    let resolveActiveIds!: (ids: Set<string>) => void;
    mockKeepActiveMessageIds.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveActiveIds = resolve;
      }),
    );
    const first = createRoomClient("token-ben");
    await waitForEvent(first, "connect");
    const firstJoined = waitForEvent(first, "room-joined");
    first.emit("join-room", { roomId });
    await waitFor(() => expect(mockKeepActiveMessageIds).toHaveBeenCalled());

    const liveMessage = waitForEvent<{ id: string }>(first, "message");
    first.emit("message", {
      roomId,
      ciphertext: "new-ciphertext",
      nonce: "new-nonce",
    });
    const appended = await liveMessage;
    resolveActiveIds(new Set(["checked-message"]));
    await firstJoined;

    const second = createRoomClient("token-cara");
    await waitForEvent(second, "connect");
    const secondJoined = waitForEvent<{ messages: Array<{ id: string }> }>(
      second,
      "room-joined",
    );
    second.emit("join-room", { roomId, createIfMissing: false });
    const replay = await secondJoined;
    expect(replay.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(["checked-message", appended.id]),
    );
  });

  it("holds concurrent reconnects until cold deletion reconciliation finishes", async () => {
    const roomId = `cold-recheck-concurrent-${Date.now()}`;
    mockLoadEncryptedMessages.mockResolvedValueOnce([
      {
        id: "deleted-before-attachment",
        ciphertext: "ciphertext",
        nonce: "nonce",
        userId: "user-ada",
        username: "Ada",
        timestamp: 10,
        type: "text",
        systemContent: null,
      },
    ]);
    let resolveActiveIds!: (ids: Set<string>) => void;
    mockKeepActiveMessageIds.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveActiveIds = resolve;
      }),
    );
    const first = createRoomClient("token-ben");
    const second = createRoomClient("token-cara");
    await Promise.all([
      waitForEvent(first, "connect"),
      waitForEvent(second, "connect"),
    ]);
    const firstJoined = waitForEvent<{ messages: Array<{ id: string }> }>(
      first,
      "room-joined",
    );
    const secondJoined = waitForEvent<{ messages: Array<{ id: string }> }>(
      second,
      "room-joined",
    );
    first.emit("join-room", { roomId });
    await waitFor(() => expect(mockKeepActiveMessageIds).toHaveBeenCalled());
    second.emit("join-room", { roomId, createIfMissing: false });

    resolveActiveIds(new Set());
    const [firstReplay, secondReplay] = await Promise.all([
      firstJoined,
      secondJoined,
    ]);
    expect(firstReplay.messages.some((message) => message.id === "deleted-before-attachment"))
      .toBe(false);
    expect(secondReplay.messages.some((message) => message.id === "deleted-before-attachment"))
      .toBe(false);
  });

  it("assigns one hydration owner when reconnects start before database loading finishes", async () => {
    const roomId = `cold-hydration-owner-${Date.now()}`;
    let resolveLoadedMessages!: (
      messages: Array<{
        id: string;
        ciphertext: string;
        nonce: string;
        userId: string;
        username: string;
        timestamp: number;
        type: "text";
        systemContent: null;
      }>,
    ) => void;
    mockLoadEncryptedMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoadedMessages = resolve;
      }),
    );
    mockKeepActiveMessageIds.mockResolvedValueOnce(new Set());
    const first = createRoomClient("token-ben");
    const second = createRoomClient("token-cara");
    await Promise.all([
      waitForEvent(first, "connect"),
      waitForEvent(second, "connect"),
    ]);
    const firstJoined = waitForEvent<{ messages: Array<{ id: string }> }>(
      first,
      "room-joined",
    );
    const secondJoined = waitForEvent<{ messages: Array<{ id: string }> }>(
      second,
      "room-joined",
    );
    first.emit("join-room", { roomId });
    second.emit("join-room", { roomId, createIfMissing: false });
    await waitFor(() => expect(mockLoadEncryptedMessages).toHaveBeenCalledTimes(1));

    resolveLoadedMessages([
      {
        id: "deleted-during-load",
        ciphertext: "ciphertext",
        nonce: "nonce",
        userId: "user-ada",
        username: "Ada",
        timestamp: 10,
        type: "text",
        systemContent: null,
      },
    ]);
    const [firstReplay, secondReplay] = await Promise.all([
      firstJoined,
      secondJoined,
    ]);

    expect(mockLoadEncryptedMessages).toHaveBeenCalledTimes(1);
    expect(firstReplay.messages.some((message) => message.id === "deleted-during-load"))
      .toBe(false);
    expect(secondReplay.messages.some((message) => message.id === "deleted-during-load"))
      .toBe(false);
  });

  it("invalidates failed cold hydration before waking concurrent joins", async () => {
    const roomId = `cold-hydration-failure-${Date.now()}`;
    mockLoadEncryptedMessages.mockResolvedValueOnce([
      {
        id: "unverified-message",
        ciphertext: "ciphertext",
        nonce: "nonce",
        userId: "user-ada",
        username: "Ada",
        timestamp: 10,
        type: "text",
        systemContent: null,
      },
    ]);
    let rejectActiveIds!: (error: Error) => void;
    mockKeepActiveMessageIds.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectActiveIds = reject;
      }),
    );
    const first = createRoomClient("token-ben");
    const second = createRoomClient("token-cara");
    await Promise.all([
      waitForEvent(first, "connect"),
      waitForEvent(second, "connect"),
    ]);
    const firstError = waitForEvent<{ message: string }>(first, "error");
    const secondError = waitForEvent<{ message: string }>(second, "error");
    first.emit("join-room", { roomId });
    await waitFor(() => expect(mockKeepActiveMessageIds).toHaveBeenCalled());
    second.emit("join-room", { roomId, createIfMissing: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    rejectActiveIds(new Error("recheck failed"));

    await expect(firstError).resolves.toMatchObject({
      message: "Unable to join this room. Please try again.",
    });
    await expect(secondError).resolves.toMatchObject({
      message: "Unable to join this room. Please try again.",
    });

    const retry = createRoomClient("token-dana");
    await waitForEvent(retry, "connect");
    const retryJoined = waitForEvent(retry, "room-joined");
    retry.emit("join-room", { roomId, createIfMissing: false });
    await expect(retryJoined).resolves.toMatchObject({ roomId });
    expect(mockLoadEncryptedMessages).toHaveBeenCalledTimes(2);
  });

  it("does not deliver a recovery page after room access is revoked mid-read", async () => {
    const roomId = `recovery-revoked-${Date.now()}`;
    const persistedMessage = (id: string) => ({
      id,
      ciphertext: "ciphertext",
      nonce: "nonce",
      userId: "user-ada",
      username: "Ada",
      timestamp: 2,
      type: "text" as const,
      systemContent: null,
    });
    let resolveRecovery!: (value: {
      messages: Array<ReturnType<typeof persistedMessage>>;
      hasMore: boolean;
    }) => void;
    mockLoadEncryptedMessagesAfter.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRecovery = resolve;
      }),
    );
    const client = createRoomClient("token-ben");
    await waitForEvent(client, "connect");
    const joined = waitForEvent(client, "room-joined");
    client.emit("join-room", { roomId });
    await joined;

    const accessRevoked = waitForEvent<{ code: string }>(
      client,
      "message-recovery-error",
    );
    const receivedPage = vi.fn();
    client.on("message-recovery-page", receivedPage);
    client.emit("recover-messages", {
      requestId: "revoked-read",
      roomId,
      afterMessageId: "known",
      afterTimestamp: 1,
      deletedAfter: 0,
    });
    await waitFor(() => expect(mockLoadEncryptedMessagesAfter).toHaveBeenCalled());
    client.emit("leave-room", { roomId });
    await waitFor(() => expect(getRooms()).toEqual([]));
    resolveRecovery({
      messages: [persistedMessage("must-not-be-delivered")],
      hasMore: false,
    });

    await expect(accessRevoked).resolves.toEqual({
      requestId: "revoked-read",
      code: "ROOM_ACCESS_REVOKED",
    });
    expect(receivedPage).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated client before it can create or join a room", async () => {
    const client = createRoomClient();
    const error = await waitForEvent<Error>(client, "connect_error");

    expect(error.message).toBe("Authentication required.");
    expect(getRooms()).toEqual([]);
  });

  it("creates, lists, joins, and removes a room through authenticated clients", async () => {
    const roomId = `kick-restart-${Date.now()}`;
    const ada = createRoomClient("token-ada");
    await waitForEvent(ada, "connect");

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId, roomName: "Lifecycle room" });

    await expect(adaJoined).resolves.toMatchObject({
      roomId,
      roomName: "Lifecycle room",
      users: [{ userId: "user-ada" }],
      canModerate: true,
    });
    expect(getRooms()).toEqual([
      expect.objectContaining({
        id: roomId,
        name: "Lifecycle room",
        userCount: 1,
      }),
    ]);

    const ben = createRoomClient("token-ben");
    await waitForEvent(ben, "connect");
    const benJoined = waitForEvent<{
      canModerate: boolean;
      users: Array<{ userId: string }>;
    }>(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });

    const benRoom = await benJoined;
    expect(benRoom.canModerate).toBe(false);
    expect(benRoom.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user-ada" }),
        expect.objectContaining({ userId: "user-ben" }),
      ]),
    );
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 2 }),
    ]);

    mockIsConfiguredAdmin.mockImplementation(
      (userId: string) => userId === "user-ben",
    );
    await expect(
      kickRoomMember(roomId, "user-ada", "user-ben"),
    ).resolves.toBe("protected-target");
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 2 }),
    ]);
    mockIsConfiguredAdmin.mockReturnValue(false);

    const adaSawBenLeave = waitForEvent<{ userId: string }>(ada, "user-left");
    ben.emit("leave-room", { roomId });
    await expect(adaSawBenLeave).resolves.toEqual(
      expect.objectContaining({ userId: "user-ben" }),
    );
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 1 }),
    ]);

    const benRejoined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await expect(benRejoined).resolves.toBeTruthy();
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 2 }),
    ]);

    ben.emit("leave-room", { roomId });
    ada.emit("leave-room", { roomId });
    await waitFor(() => expect(getRooms()).toEqual([]));
  });

  it("uses the account profile instead of a spoofed socket identity", async () => {
    const roomId = `kick-restart-${Date.now()}`;
    const client = createRoomClient("token-ada", "Spoofed name");
    await waitForEvent(client, "connect");
    const joined = waitForEvent<{
      users: Array<{
        userId: string;
        username: string;
        avatarEmoji: string;
      }>;
    }>(client, "room-joined");

    client.emit("join-room", { roomId });

    await expect(joined).resolves.toMatchObject({
      users: [
        {
          userId: "user-ada",
          username: "Ada",
          avatarEmoji: "👩‍💻",
        },
      ],
    });
  });

  it("rejects a banned user trying to reconnect with a valid Clerk token", async () => {
    mockGetAccountAccess.mockResolvedValue({ allowed: false, reason: "banned" });
    const client = createRoomClient("token-ben");

    const error = await waitForEvent<Error>(client, "connect_error");

    expect(error.message).toBe("Your RealtimeAlgoChatApp Studio account has been banned.");
  });

  it("disconnects an active banned user before they can keep using a room", async () => {
    const ben = createRoomClient("token-ben");
    await waitForEvent(ben, "connect");
    const joined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId: "ban-active-room" });
    await joined;

    const revoked = waitForEvent<{ reason: string }>(ben, "access-revoked");
    const disconnected = waitForEvent(ben, "disconnect");
    disconnectBannedUser("user-ben");

    await expect(revoked).resolves.toEqual({ reason: "banned" });
    await expect(disconnected).resolves.toBeTruthy();
  });

  it("allows a configured admin to kick a non-admin from another creator's room", async () => {
    const roomId = `kick-restart-${Date.now()}`;
    const ben = createRoomClient("token-ben");
    const ada = createRoomClient("token-ada");
    await Promise.all([waitForEvent(ben, "connect"), waitForEvent(ada, "connect")]);

    const benJoined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId });
    await benJoined;

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId, createIfMissing: false });
    await adaJoined;

    mockIsConfiguredAdmin.mockImplementation(
      (userId: string) => userId === "user-ada",
    );
    const kicked = waitForEvent<{ roomId: string; userId: string }>(ben, "kicked");

    await expect(
      kickRoomMember(roomId, "user-ada", "user-ben"),
    ).resolves.toBe("ok");
    await expect(kicked).resolves.toEqual({ roomId, userId: "user-ben" });
    expect(getRooms()).toEqual([
      expect.objectContaining({ id: roomId, userCount: 1 }),
    ]);
  });

  it("keeps a kicked member on cooldown after the socket server restarts", async () => {
    const roomId = `kick-restart-${Date.now()}`;
    const ada = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    await Promise.all([waitForEvent(ada, "connect"), waitForEvent(ben, "connect")]);

    const adaJoined = waitForEvent(ada, "room-joined");
    ada.emit("join-room", { roomId });
    await adaJoined;

    const benJoined = waitForEvent(ben, "room-joined");
    ben.emit("join-room", { roomId, createIfMissing: false });
    await benJoined;

    const kicked = waitForEvent<{ roomId: string; userId: string }>(ben, "kicked");
    await expect(kickRoomMember(roomId, "user-ada", "user-ben")).resolves.toBe("ok");
    await expect(kicked).resolves.toEqual({ roomId, userId: "user-ben" });

    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    httpServer = createServer();
    socketServer = setupSocketIO(httpServer);
    httpServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const { port } = httpServer.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;

    const benAfterRestart = createRoomClient("token-ben");
    await waitForEvent(benAfterRestart, "connect");
    const denied = waitForEvent<{ message: string }>(benAfterRestart, "error");
    benAfterRestart.emit("join-room", { roomId, createIfMissing: false });
    await expect(denied).resolves.toEqual({
      message:
        "You were recently removed from this room. Please wait a few minutes before rejoining.",
    });
  });

  it("rejects messages before mutation or broadcast when persistence is saturated", async () => {
    mockSaveEncryptedMessage.mockImplementation(
      () => new Promise<void>(() => {}),
    );
    const roomId = `persistence-capacity-${Date.now()}`;
    const ada = createRoomClient("token-ada");
    const ben = createRoomClient("token-ben");
    const cara = createRoomClient("token-cara");
    const dana = createRoomClient("token-dana");
    await Promise.all([
      waitForEvent(ada, "connect"),
      waitForEvent(ben, "connect"),
      waitForEvent(cara, "connect"),
      waitForEvent(dana, "connect"),
    ]);
    for (const client of [ada, ben, cara, dana]) {
      const joined = waitForEvent(client, "room-joined");
      client.emit("join-room", { roomId, createIfMissing: client === ada });
      await joined;
    }

    const received = vi.fn();
    ada.on("message", received);
    const sendMessages = (client: ClientSocket, count: number) => {
      for (let index = 0; index < count; index += 1) {
        client.emit("message", {
          roomId,
          ciphertext: `message-${client.id}-${index}`,
          nonce: "nonce",
        });
      }
    };
    sendMessages(ben, 85);
    sendMessages(cara, 85);
    sendMessages(dana, 86);
    await waitFor(
      () => {
        expect(mockSaveEncryptedMessage).toHaveBeenCalledTimes(256);
        expect(received).not.toHaveBeenCalled();
      },
      { attempts: 100, delayMs: 20 },
    );

    const persistenceBusy = waitForEvent<{ code: string }>(dana, "error");
    dana.emit("message", {
      roomId,
      ciphertext: "not-persisted",
      nonce: "nonce",
    });
    await expect(persistenceBusy).resolves.toMatchObject({
      code: "PERSISTENCE_BUSY",
      message: "Realtime storage is busy. Please try again shortly.",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSaveEncryptedMessage).toHaveBeenCalledTimes(256);
    expect(received).not.toHaveBeenCalled();
  });
});
