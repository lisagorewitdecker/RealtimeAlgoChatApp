import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockStreamSandboxAssistant = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({ verifyToken: vi.fn() }));
vi.mock("./lib/sandboxAssistant", () => ({
  streamSandboxAssistant: mockStreamSandboxAssistant,
}));
vi.mock("./lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: () => false,
}));

import { createRoomAccessCapability } from "./lib/roomAccess.js";
import { setupSocketIO } from "./socket.js";

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  process.env["SESSION_SECRET"] = "assistant-test-session-secret";
  mockStreamSandboxAssistant.mockReset();
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
  return new Promise<T>((resolve) =>
    socket.once(event, (payload: T) => resolve(payload)),
  );
}

async function connectSandboxClient(roomId: string) {
  const token = createRoomAccessCapability({
    roomId,
    userId: "user-ada",
    username: "Ada",
    avatarEmoji: "🧑‍💻",
    purpose: "sandbox",
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

describe("encrypted sandbox assistant privacy boundary", () => {
  it("rejects plaintext prompts and files without invoking the model", async () => {
    const roomId = "assistant-disabled";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<{ requestId: string; message: string }>(
      client,
      "assistant-error",
    );

    client.emit("assistant-request", {
      requestId: "assistant-disabled-request",
      roomId,
      prompt: "Review private code.",
      files: { html: "<p>secret</p>", css: "", js: "" },
    });

    await expect(error).resolves.toEqual({
      requestId: "assistant-disabled-request",
      message: "The coding assistant is disabled for encrypted rooms.",
    });
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });
});