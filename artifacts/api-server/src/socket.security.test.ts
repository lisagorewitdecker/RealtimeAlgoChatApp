import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockGetAccountAccess = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  verifyToken: vi.fn(),
}));

vi.mock("./lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: () => false,
}));

vi.mock("./lib/sandboxAssistant", () => ({
  streamSandboxAssistant: vi.fn(),
}));

import { createRoomAccessCapability } from "./lib/roomAccess.js";
import { setupSocketIO } from "./socket.js";

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  process.env["SESSION_SECRET"] = "socket-security-test-secret";
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
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

async function connectCapability({
  roomId,
  userId,
  purpose,
}: {
  roomId: string;
  userId: string;
  purpose: "call" | "sandbox";
}) {
  const token = createRoomAccessCapability({
    roomId,
    userId,
    username: userId === "user-ada" ? "Ada" : "Ben",
    avatarEmoji: "🧑‍💻",
    purpose,
  });
  const client = createClient(serverUrl, {
    auth: { token },
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  clients.push(client);
  await waitForEvent(client, "connect");
  const joined = waitForEvent(client, "room-joined");
  client.emit("join-room", { roomId });
  await joined;
  return client;
}

async function expectNoEvent(
  socket: ClientSocket,
  event: string,
  send: () => void,
) {
  const received = vi.fn();
  socket.once(event, received);
  send();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(received).not.toHaveBeenCalled();
}

describe("room-scoped socket capabilities", () => {
  it("blocks cross-room WebRTC relays and blocks call capabilities from chat or sandbox updates", async () => {
    const callInAlpha = await connectCapability({
      roomId: "room-alpha",
      userId: "user-ada",
      purpose: "call",
    });
    const sandboxInAlpha = await connectCapability({
      roomId: "room-alpha",
      userId: "user-ben",
      purpose: "sandbox",
    });
    const callInBeta = await connectCapability({
      roomId: "room-beta",
      userId: "user-ben",
      purpose: "call",
    });

    await expectNoEvent(sandboxInAlpha, "message", () => {
      callInAlpha.emit("message", {
        roomId: "room-alpha",
        content: "Call capabilities must not chat.",
      });
    });
    await expectNoEvent(sandboxInAlpha, "sandbox-update", () => {
      callInAlpha.emit("sandbox-update", {
        roomId: "room-alpha",
        html: "<p>unsafe</p>",
        css: "",
        js: "",
      });
    });
    await expectNoEvent(callInAlpha, "sandbox-update", () => {
      sandboxInAlpha.emit("sandbox-update", {
        roomId: "room-alpha",
        html: "<p>server-readable secret</p>",
        css: "",
        js: "",
      });
    });
    const encryptedSandbox = waitForEvent<{
      ciphertext: string;
      nonce: string;
      html?: string;
    }>(callInAlpha, "sandbox-update");
    sandboxInAlpha.emit("sandbox-update", {
      roomId: "room-alpha",
      ciphertext: "c2FuZGJveC1jaXBoZXJ0ZXh0",
      nonce: "c2FuZGJveC1ub25jZQ==",
    });
    await expect(encryptedSandbox).resolves.toEqual({
      ciphertext: "c2FuZGJveC1jaXBoZXJ0ZXh0",
      nonce: "c2FuZGJveC1ub25jZQ==",
    });
    await expectNoEvent(callInBeta, "webrtc-offer", () => {
      callInAlpha.emit("webrtc-offer", {
        roomId: "room-beta",
        to: "user-ben",
        offer: { type: "offer", sdp: "not-in-this-room" },
      });
    });
  });

  it("does not allow a room-scoped capability to join another room", async () => {
    const client = await connectCapability({
      roomId: "room-alpha",
      userId: "user-ada",
      purpose: "sandbox",
    });
    const error = waitForEvent<{ message: string }>(client, "error");

    client.emit("join-room", { roomId: "room-beta" });

    await expect(error).resolves.toEqual({
      message: "This room access session is restricted.",
    });
  });
});