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

import {
  ASSISTANT_REQUEST_COOLDOWN_MS,
  MAX_ASSISTANT_PROMPT_LENGTH,
} from "./lib/assistantLimits.js";
import {
  createRoomAccessCapability,
  type RoomAccessPurpose,
} from "./lib/roomAccess.js";
import { setupSocketIO } from "./socket.js";

interface AssistantErrorEvent {
  requestId?: string;
  code?: string;
  message: string;
  retryAfterSeconds?: number;
}

interface AssistantChunkEvent {
  requestId: string;
  text: string;
}

interface AssistantDoneEvent {
  requestId: string;
  cancelled: boolean;
}

interface StreamArgs {
  prompt: string;
  files: { html: string; css: string; js: string };
  signal: AbortSignal;
  onText: (text: string) => void;
}

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
  vi.restoreAllMocks();
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

function collectEvents<T>(socket: ClientSocket, event: string): T[] {
  const events: T[] = [];
  socket.on(event, (payload: T) => events.push(payload));
  return events;
}

function settle(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectClient(roomId: string, purpose: RoomAccessPurpose) {
  const token = createRoomAccessCapability({
    roomId,
    userId: "user-ada",
    username: "Ada",
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
  return client;
}

async function connectSandboxClient(roomId: string) {
  const client = await connectClient(roomId, "sandbox");
  const joined = waitForEvent(client, "room-joined");
  client.emit("join-room", { roomId });
  await joined;
  return client;
}

function acknowledgedRequest(roomId: string, requestId: string) {
  return {
    requestId,
    roomId,
    prompt: "Why does my button overflow its container?",
    files: { html: "<button>Go</button>", css: "button{width:120%}", js: "" },
    disclosureAcknowledged: true,
  };
}

/** A model stream that only ends when its abort signal fires. */
function streamUntilAborted() {
  let capturedSignal: AbortSignal | undefined;
  mockStreamSandboxAssistant.mockImplementation(
    ({ signal }: StreamArgs) =>
      new Promise<void>((_resolve, reject) => {
        capturedSignal = signal;
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted by test stream")),
          { once: true },
        );
      }),
  );
  return () => capturedSignal;
}

describe("sandbox assistant disclosure gate", () => {
  it("rejects requests without the acknowledgement and never contacts the model", async () => {
    const roomId = "assistant-gate";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");
    const { disclosureAcknowledged: _omitted, ...withoutAcknowledgement } =
      acknowledgedRequest(roomId, "assistant-gate-request");

    client.emit("assistant-request", withoutAcknowledgement);

    const received = await error;
    expect(received.requestId).toBe("assistant-gate-request");
    expect(received.code).toBe("DISCLOSURE_REQUIRED");
    expect(received.message).toMatch(/privacy notice/i);
    expect(received.message).toMatch(/end-to-end encryption/i);
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });

  it("only accepts a literal boolean acknowledgement", async () => {
    const roomId = "assistant-gate-strict";
    const client = await connectSandboxClient(roomId);
    const errors = collectEvents<AssistantErrorEvent>(client, "assistant-error");

    for (const value of ["true", 1, {}, null]) {
      client.emit("assistant-request", {
        ...acknowledgedRequest(roomId, "assistant-gate-strict-request"),
        disclosureAcknowledged: value,
      });
    }
    await settle();

    expect(errors).toHaveLength(4);
    expect(errors.every((error) => error.code === "DISCLOSURE_REQUIRED")).toBe(
      true,
    );
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });

  it("keeps rejecting non-sandbox sessions even with the acknowledgement", async () => {
    const roomId = "assistant-call-session";
    const client = await connectClient(roomId, "call");
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-call-request"),
    );

    await expect(error).resolves.toEqual({
      message: "This session cannot use the coding assistant.",
    });
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });

  it("requires the request to target the joined room", async () => {
    const client = await connectSandboxClient("assistant-joined-room");
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");

    client.emit(
      "assistant-request",
      acknowledgedRequest("assistant-other-room", "assistant-other-request"),
    );

    expect((await error).code).toBe("NOT_IN_ROOM");
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });

  it("rejects oversized prompts before contacting the model", async () => {
    const roomId = "assistant-invalid";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");

    client.emit("assistant-request", {
      ...acknowledgedRequest(roomId, "assistant-invalid-request"),
      prompt: "x".repeat(MAX_ASSISTANT_PROMPT_LENGTH + 1),
    });

    const received = await error;
    expect(received.code).toBe("INVALID_REQUEST");
    expect(received.message).toContain("2,000");
    expect(mockStreamSandboxAssistant).not.toHaveBeenCalled();
  });
});

describe("sandbox assistant streaming", () => {
  it("streams the reply and sends the model only the prompt and files", async () => {
    const roomId = "assistant-stream";
    const client = await connectSandboxClient(roomId);
    const chunks = collectEvents<AssistantChunkEvent>(client, "assistant-chunk");
    const errors = collectEvents<AssistantErrorEvent>(client, "assistant-error");
    const done = waitForEvent<AssistantDoneEvent>(client, "assistant-done");
    mockStreamSandboxAssistant.mockImplementation(async ({ onText }: StreamArgs) => {
      onText("Set ");
      onText("`width: 100%`.");
    });
    const request = acknowledgedRequest(roomId, "assistant-stream-request");

    client.emit("assistant-request", request);

    await expect(done).resolves.toEqual({
      requestId: "assistant-stream-request",
      cancelled: false,
    });
    expect(chunks).toEqual([
      { requestId: "assistant-stream-request", text: "Set " },
      { requestId: "assistant-stream-request", text: "`width: 100%`." },
    ]);
    expect(errors).toEqual([]);
    expect(mockStreamSandboxAssistant).toHaveBeenCalledTimes(1);
    const [args] = mockStreamSandboxAssistant.mock.calls[0] as [StreamArgs];
    expect(Object.keys(args).sort()).toEqual(["files", "onText", "prompt", "signal"]);
    expect(args.prompt).toBe(request.prompt);
    expect(args.files).toEqual(request.files);
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops a running reply on cancel and aborts the model stream", async () => {
    const roomId = "assistant-cancel";
    const client = await connectSandboxClient(roomId);
    const errors = collectEvents<AssistantErrorEvent>(client, "assistant-error");
    const done = waitForEvent<AssistantDoneEvent>(client, "assistant-done");
    const getSignal = streamUntilAborted();

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-cancel-request"),
    );
    await vi.waitFor(() => expect(getSignal()).toBeDefined());
    client.emit("assistant-cancel", {
      requestId: "assistant-cancel-request",
      roomId,
    });

    await expect(done).resolves.toEqual({
      requestId: "assistant-cancel-request",
      cancelled: true,
    });
    expect(getSignal()?.aborted).toBe(true);
    await settle();
    expect(errors).toEqual([]);
  });

  it("aborts the model stream when the client leaves the room", async () => {
    const roomId = "assistant-leave";
    const client = await connectSandboxClient(roomId);
    const getSignal = streamUntilAborted();

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-leave-request"),
    );
    await vi.waitFor(() => expect(getSignal()).toBeDefined());
    client.emit("leave-room", { roomId });

    await vi.waitFor(() => expect(getSignal()?.aborted).toBe(true));
  });

  it("allows one request per socket at a time", async () => {
    const roomId = "assistant-busy";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");
    const getSignal = streamUntilAborted();

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-busy-first"),
    );
    await vi.waitFor(() => expect(getSignal()).toBeDefined());
    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-busy-second"),
    );

    const received = await error;
    expect(received).toMatchObject({
      requestId: "assistant-busy-second",
      code: "REQUEST_IN_PROGRESS",
    });
    expect(mockStreamSandboxAssistant).toHaveBeenCalledTimes(1);
  });

  it("enforces the cooldown between requests with a countdown", async () => {
    const roomId = "assistant-cooldown";
    const client = await connectSandboxClient(roomId);
    const errors = collectEvents<AssistantErrorEvent>(client, "assistant-error");
    const doneEvents = collectEvents<AssistantDoneEvent>(client, "assistant-done");
    mockStreamSandboxAssistant.mockImplementation(async ({ onText }: StreamArgs) => {
      onText("ok");
    });

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-cooldown-first"),
    );
    await vi.waitFor(() => expect(doneEvents).toHaveLength(1));
    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-cooldown-second"),
    );
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0]).toMatchObject({
      requestId: "assistant-cooldown-second",
      code: "COOLDOWN",
      retryAfterSeconds: 1,
    });
    expect(mockStreamSandboxAssistant).toHaveBeenCalledTimes(1);

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(
      () => realNow + ASSISTANT_REQUEST_COOLDOWN_MS + 50,
    );
    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-cooldown-third"),
    );
    await vi.waitFor(() => expect(doneEvents).toHaveLength(2));
    expect(doneEvents[1]).toEqual({
      requestId: "assistant-cooldown-third",
      cancelled: false,
    });
    expect(mockStreamSandboxAssistant).toHaveBeenCalledTimes(2);
  });

  it("turns model rate limits into a retry countdown", async () => {
    const roomId = "assistant-rate-limit";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");
    mockStreamSandboxAssistant.mockRejectedValue(
      Object.assign(new Error("429 rate limited"), {
        status: 429,
        headers: { "retry-after": "12" },
      }),
    );

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-rate-limit-request"),
    );

    const received = await error;
    expect(received).toMatchObject({
      requestId: "assistant-rate-limit-request",
      code: "RATE_LIMITED",
      retryAfterSeconds: 12,
    });
    expect(received.message).toContain("12 seconds");
  });

  it("reports service failures as recoverable without leaking details", async () => {
    const roomId = "assistant-service-error";
    const client = await connectSandboxClient(roomId);
    const error = waitForEvent<AssistantErrorEvent>(client, "assistant-error");
    const done = collectEvents<AssistantDoneEvent>(client, "assistant-done");
    mockStreamSandboxAssistant.mockRejectedValue(
      new Error("upstream exploded: internal-host-name"),
    );

    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-service-error-request"),
    );

    const received = await error;
    expect(received.requestId).toBe("assistant-service-error-request");
    expect(received.code).toBe("SERVICE_ERROR");
    expect(received.message).toMatch(/try again/i);
    expect(received.message).not.toContain("internal-host-name");
    await settle();
    expect(done).toEqual([]);

    // The socket is usable again after a failure.
    mockStreamSandboxAssistant.mockImplementation(async ({ onText }: StreamArgs) => {
      onText("recovered");
    });
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(
      () => realNow + ASSISTANT_REQUEST_COOLDOWN_MS + 50,
    );
    client.emit(
      "assistant-request",
      acknowledgedRequest(roomId, "assistant-service-error-retry"),
    );
    await vi.waitFor(() => expect(done).toHaveLength(1));
  });
});
