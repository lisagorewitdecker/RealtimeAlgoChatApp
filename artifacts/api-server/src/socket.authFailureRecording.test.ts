import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockRecordSocketAuthFailure = vi.hoisted(() => vi.fn());
const mockRecordSocketDisconnect = vi.hoisted(() => vi.fn());
const mockReportSocketHandlerError = vi.hoisted(() => vi.fn());

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
  recordSocketDisconnect: mockRecordSocketDisconnect,
  reportSocketHandlerError: mockReportSocketHandlerError,
}));

import { createRoomAccessCapability } from "./lib/roomAccess.js";
import { setupSocketIO } from "./socket.js";

let httpServer: HttpServer;
let socketServer: ReturnType<typeof setupSocketIO>;
let serverUrl: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  process.env["SESSION_SECRET"] = "socket-auth-failure-test-secret";
  mockVerifyToken.mockReset();
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockGetAccountProfile
    .mockReset()
    .mockResolvedValue({ username: "Ada", avatarEmoji: "👩‍💻" });
  mockRecordSocketAuthFailure.mockReset();
  mockRecordSocketDisconnect.mockReset();
  mockReportSocketHandlerError.mockReset();

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

describe("Socket.IO auth-failure and disconnect recording", () => {
  it("records a missing-token rejection", async () => {
    const client = connect({});
    await waitForEvent(client, "connect_error");
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("missing_token");
  });

  it("records a banned-account rejection", async () => {
    mockVerifyToken.mockResolvedValue({ sub: "user-banned" });
    mockGetAccountAccess.mockResolvedValue({ allowed: false, reason: "banned" });
    const client = connect({ token: "token-banned" });
    await waitForEvent(client, "connect_error");
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("banned");
  });

  it("records an unverified-email rejection", async () => {
    mockVerifyToken.mockResolvedValue({ sub: "user-unverified" });
    mockGetAccountAccess.mockResolvedValue({ allowed: false, reason: "unverified" });
    const client = connect({ token: "token-unverified" });
    await waitForEvent(client, "connect_error");
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("unverified_email");
  });

  it("records an invalid-session rejection when token verification throws, without filing a Sentry exception", async () => {
    // An invalid/expired token is a routine, expected auth rejection, not a
    // bug -- it should count toward the rate alert but not create a Sentry
    // exception per bad handshake.
    mockVerifyToken.mockRejectedValue(new Error("boom"));
    const client = connect({ token: "token-broken" });
    await waitForEvent(client, "connect_error");
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("invalid_session");
    expect(mockReportSocketHandlerError).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure in the room-capability auth path (e.g. a database error) to Sentry", async () => {
    // getAccountAccess can be reached via the room-access-capability branch
    // too, before the Clerk-token try/catch -- a thrown error there must
    // still be caught, recorded, and reported, not left as an unhandled
    // rejection in the Socket.IO middleware.
    const capability = createRoomAccessCapability({
      roomId: "room-cap",
      userId: "user-cap",
      username: "Cap",
      avatarEmoji: "🧑‍💻",
      purpose: "call",
    });
    mockGetAccountAccess.mockRejectedValue(new Error("db unavailable"));

    const client = connect({ token: capability });
    await waitForEvent(client, "connect_error");
    expect(mockRecordSocketAuthFailure).toHaveBeenCalledWith("unexpected_error");
    expect(mockReportSocketHandlerError).toHaveBeenCalledWith(
      "connection-auth",
      expect.any(Error),
    );
  });

  it("records the disconnect reason when a client disconnects", async () => {
    mockVerifyToken.mockResolvedValue({ sub: "user-ada" });
    const client = connect({ token: "token-ada" });
    await waitForEvent(client, "connect");
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockRecordSocketDisconnect).toHaveBeenCalledTimes(1);
    expect(mockRecordSocketDisconnect.mock.calls[0]![0]).toEqual(expect.any(String));
  });
});
