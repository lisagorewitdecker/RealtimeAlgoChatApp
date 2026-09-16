import type { Server as HttpServer } from "node:http";
import { verifyToken } from "@clerk/express";
import {
  Server,
  Socket,
  type DefaultEventsMap,
  type ExtendedError,
} from "socket.io";
import { logger } from "./lib/logger";
import { getAccountProfile } from "./lib/accountProfile";
import {
  ACCOUNT_ACCESS_UNAVAILABLE_CODE,
  ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
  AccountAccessUnavailableError,
} from "./lib/accountAccessUnavailable";
import { isAllowedOrigin } from "./lib/origins";
import {
  verifyRoomAccessCapability,
  type RoomAccessPurpose,
} from "./lib/roomAccess";
import {
  db,
  roomBansTable,
  roomKickCooldownsTable,
  roomsTable,
} from "@workspace/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  getAnthropicRetryAfterSeconds,
  getAssistantRateLimitCountdown,
  isAnthropicRateLimitError,
} from "./lib/assistantErrors";
import {
  ASSISTANT_DISCLOSURE_FIELD,
  ASSISTANT_DISCLOSURE_REQUIRED_MESSAGE,
  ASSISTANT_REQUEST_COOLDOWN_MS,
  ASSISTANT_TIMEOUT_MS,
  MAX_ASSISTANT_CONTEXT_LENGTH,
  MAX_ASSISTANT_FILE_LENGTH,
  MAX_ASSISTANT_PROMPT_LENGTH,
} from "./lib/assistantLimits";
import { getAccountAccess, isConfiguredAdmin } from "./lib/accountAccess";
import { streamSandboxAssistant } from "./lib/sandboxAssistant";
import {
  getPublicKey,
  getPublicKeyRecord,
  getRoomEnvelope,
  keepActiveMessageIds,
  loadDeletedMessageIdsAfter,
  loadEncryptedMessages,
  loadEncryptedMessagesAfter,
  loadEncryptedSandboxState,
  saveEncryptedMessage,
  saveEncryptedSandboxState,
  saveRoomEnvelope,
  type EncryptedPayload,
} from "./lib/e2eePersistence";
import {
  recordSocketAuthFailure,
  recordSocketDisconnect,
  reportSocketHandlerError,
} from "./lib/socketMonitoring";

interface User {
  userId: string;
  username: string;
  avatarEmoji: string;
  publicKey: string | null;
  socketIds: Set<string>;
}

interface Message {
  id: string;
  content?: string;
  ciphertext?: string;
  nonce?: string;
  userId: string;
  username: string;
  avatarEmoji: string;
  timestamp: number;
  type: "text" | "system";
}

interface Room {
  id: string;
  name: string;
  createdByUserId: string;
  users: Map<string, User>;
  messages: Message[];
  sandboxState: EncryptedPayload | null;
  createdAt: number;
}

const rooms = new Map<string, Room>();
const DEFAULT_AVATAR_EMOJI = "🧑‍💻";
const DEFAULT_USERNAME = "Member";
const ASSISTANT_REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

type SessionPurpose = "chat" | RoomAccessPurpose;

interface AuthenticatedUser {
  userId: string;
  username: string;
  avatarEmoji: string;
  purpose: SessionPurpose;
  restrictedRoomId?: string;
}

interface SocketData {
  authenticatedUser?: AuthenticatedUser;
  roomId?: string;
  connectionLease?: ConnectionLease;
  lastRateLimitNoticeAt?: number;
}

interface AssistantRequest {
  requestId: string;
  prompt: string;
  files: {
    html: string;
    css: string;
    js: string;
  };
}

interface ActiveAssistantRequest {
  requestId: string;
  controller: AbortController;
  timeout: NodeJS.Timeout;
}

interface AssistantErrorPayload {
  code:
    | "DISCLOSURE_REQUIRED"
    | "NOT_IN_ROOM"
    | "INVALID_REQUEST"
    | "REQUEST_IN_PROGRESS"
    | "COOLDOWN";
  message: string;
  retryAfterSeconds?: number;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
type AppServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

const KICK_COOLDOWN_MS = 5 * 60 * 1000;
const SOCKET_PACKET_MAX_BYTES = 512 * 1024;
const SOCKET_CONNECTIONS_PER_ACCOUNT = 8;
const SOCKET_CONNECTIONS_PER_IP = 64;
const SOCKET_CONNECTIONS_GLOBAL = 1_000;
const SOCKET_EVENT_WINDOW_MS = 1_000;
const SOCKET_EVENTS_PER_ACCOUNT_WINDOW = 120;
const SOCKET_EVENT_BYTES_PER_ACCOUNT_WINDOW = 1_000_000;
const SOCKET_EVENTS_GLOBAL_WINDOW = 1_000;
const SOCKET_EVENT_BYTES_GLOBAL_WINDOW = 8_000_000;
const SOCKET_EVENT_BUDGET_ACCOUNTS_MAX = SOCKET_CONNECTIONS_GLOBAL;
const WEBRTC_SIGNAL_MAX_BYTES = 64 * 1024;
const WEBRTC_MAX_RECIPIENTS = SOCKET_CONNECTIONS_PER_ACCOUNT;
const ROOM_EVENT_MAX_RECIPIENTS = 64;
const ROOM_SOCKET_MAX = 64;
const CALL_PARTICIPANTS_MAX = 16;
const PENDING_SANDBOX_SAVES_MAX = 256;
const PERSISTENCE_OPERATIONS_MAX = 256;

const MESSAGE_RECOVERY_PAGE_SIZE = 80;
let activeServer: AppServer | null = null;
const roomHydrationGates = new Map<string, Promise<void>>();

interface ConnectionLease {
  ip: string;
  userId?: string;
  released: boolean;
}

interface ConnectionRegistry {
  active: number;
  byIp: Map<string, number>;
  byUser: Map<string, number>;
}

interface EventBudget {
  windowStartedAt: number;
  events: number;
  bytes: number;
}

interface EventBudgetRegistry {
  global: EventBudget;
  byUser: Map<string, EventBudget>;
}

type SandboxSave = Parameters<typeof saveEncryptedSandboxState>[0];

interface PendingSandboxSave {
  latest: SandboxSave | null;
}

interface PersistenceBudget {
  active: number;
}

function createConnectionRegistry(): ConnectionRegistry {
  return { active: 0, byIp: new Map(), byUser: new Map() };
}

function createEventBudgetRegistry(): EventBudgetRegistry {
  return {
    global: { windowStartedAt: Date.now(), events: 0, bytes: 0 },
    byUser: new Map(),
  };
}

function createPersistenceBudget(): PersistenceBudget {
  return { active: 0 };
}

function reservePersistence(budget: PersistenceBudget): boolean {
  if (budget.active >= PERSISTENCE_OPERATIONS_MAX) return false;
  budget.active += 1;
  return true;
}

function releasePersistence(budget: PersistenceBudget): void {
  budget.active = Math.max(0, budget.active - 1);
}

function normalizeSocketIp(address: string | undefined): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function getSocketIp(socket: AppSocket): string {
  const forwardedFor = socket.handshake.headers["x-forwarded-for"];
  const forwardedValues =
    typeof forwardedFor === "string"
      ? forwardedFor.split(",")
      : Array.isArray(forwardedFor)
        ? forwardedFor.flatMap((value) => value.split(","))
        : [];
  // Express is configured with one trusted proxy hop. The nearest client
  // address is therefore the right-most forwarded value; farther-left values
  // may have been supplied by the client before the proxy appended its value.
  const forwardedAddress = forwardedValues.at(-1)?.trim();
  return normalizeSocketIp(forwardedAddress || socket.handshake.address);
}

function reserveConnection(
  registry: ConnectionRegistry,
  ip: string,
): ConnectionLease | null {
  if (registry.active >= SOCKET_CONNECTIONS_GLOBAL) return null;
  if ((registry.byIp.get(ip) ?? 0) >= SOCKET_CONNECTIONS_PER_IP) return null;

  registry.active += 1;
  registry.byIp.set(ip, (registry.byIp.get(ip) ?? 0) + 1);
  return { ip, released: false };
}

function reserveAccountConnection(
  registry: ConnectionRegistry,
  lease: ConnectionLease,
  userId: string,
): boolean {
  if ((registry.byUser.get(userId) ?? 0) >= SOCKET_CONNECTIONS_PER_ACCOUNT) {
    return false;
  }
  lease.userId = userId;
  registry.byUser.set(userId, (registry.byUser.get(userId) ?? 0) + 1);
  return true;
}

function releaseConnection(
  registry: ConnectionRegistry,
  lease: ConnectionLease | undefined,
): void {
  if (!lease || lease.released) return;
  lease.released = true;
  registry.active = Math.max(0, registry.active - 1);

  const ipCount = (registry.byIp.get(lease.ip) ?? 1) - 1;
  if (ipCount > 0) registry.byIp.set(lease.ip, ipCount);
  else registry.byIp.delete(lease.ip);

  if (lease.userId) {
    const userCount = (registry.byUser.get(lease.userId) ?? 1) - 1;
    if (userCount > 0) registry.byUser.set(lease.userId, userCount);
    else registry.byUser.delete(lease.userId);
  }
}

function rejectHandshake(
  next: (error?: ExtendedError) => void,
  registry: ConnectionRegistry,
  lease: ConnectionLease,
  message: string,
  reason: string,
  data?: Record<string, unknown>,
): void {
  releaseConnection(registry, lease);
  recordSocketAuthFailure(reason);
  const error: ExtendedError = new Error(message);
  // Socket.IO forwards `data` to the client alongside the message, so the
  // `connect_error` handler can read structured hints such as a retry delay.
  if (data) error.data = data;
  next(error);
}

function getEventBudget(
  budget: EventBudget,
  now: number,
): EventBudget {
  if (now - budget.windowStartedAt >= SOCKET_EVENT_WINDOW_MS) {
    budget.windowStartedAt = now;
    budget.events = 0;
    budget.bytes = 0;
  }
  return budget;
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 0
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    return SOCKET_EVENT_BYTES_GLOBAL_WINDOW + 1;
  }
}

function consumeEventBudget(
  socket: AppSocket,
  registry: EventBudgetRegistry,
  payload: unknown,
): boolean {
  const userId = socket.data.authenticatedUser?.userId;
  if (!userId) return false;

  const now = Date.now();
  const bytes = serializedByteLength(payload);
  const globalBudget = getEventBudget(registry.global, now);
  const overGlobalLimit =
    globalBudget.events >= SOCKET_EVENTS_GLOBAL_WINDOW ||
    globalBudget.bytes + bytes > SOCKET_EVENT_BYTES_GLOBAL_WINDOW;
  if (overGlobalLimit) {
    notifyRateLimitedSocket(socket, now);
    return false;
  }

  for (const [accountId, budget] of registry.byUser) {
    if (now - budget.windowStartedAt >= SOCKET_EVENT_WINDOW_MS) {
      registry.byUser.delete(accountId);
    }
  }
  if (
    !registry.byUser.has(userId) &&
    registry.byUser.size >= SOCKET_EVENT_BUDGET_ACCOUNTS_MAX
  ) {
    notifyRateLimitedSocket(socket, now);
    return false;
  }
  let accountBudget = registry.byUser.get(userId);
  if (!accountBudget) {
    accountBudget = { windowStartedAt: now, events: 0, bytes: 0 };
    registry.byUser.set(userId, accountBudget);
  }
  getEventBudget(accountBudget, now);
  const overAccountLimit =
    accountBudget.events >= SOCKET_EVENTS_PER_ACCOUNT_WINDOW ||
    accountBudget.bytes + bytes > SOCKET_EVENT_BYTES_PER_ACCOUNT_WINDOW;

  if (overAccountLimit) {
    notifyRateLimitedSocket(socket, now);
    return false;
  }

  accountBudget.events += 1;
  accountBudget.bytes += bytes;
  globalBudget.events += 1;
  globalBudget.bytes += bytes;
  return true;
}

function notifyRateLimitedSocket(socket: AppSocket, now: number): void {
  if (
    socket.data.lastRateLimitNoticeAt &&
    now - socket.data.lastRateLimitNoticeAt < SOCKET_EVENT_WINDOW_MS
  ) {
    return;
  }
  socket.data.lastRateLimitNoticeAt = now;
  socket.emit("error", {
    code: "RATE_LIMITED",
    message: "Too many realtime updates. Please slow down.",
  });
}

function queueSandboxSave(
  pendingSaves: Map<string, PendingSandboxSave>,
  persistenceBudget: PersistenceBudget,
  save: SandboxSave,
): boolean {
  const existing = pendingSaves.get(save.roomId);
  if (existing) {
    existing.latest = save;
    return true;
  }
  if (
    pendingSaves.size >= PENDING_SANDBOX_SAVES_MAX ||
    !reservePersistence(persistenceBudget)
  ) {
    return false;
  }

  const pending: PendingSandboxSave = { latest: save };
  pendingSaves.set(save.roomId, pending);
  void flushSandboxSaves(pendingSaves, persistenceBudget, save.roomId, pending);
  return true;
}

async function flushSandboxSaves(
  pendingSaves: Map<string, PendingSandboxSave>,
  persistenceBudget: PersistenceBudget,
  roomId: string,
  pending: PendingSandboxSave,
): Promise<void> {
  while (pending.latest) {
    const save = pending.latest;
    pending.latest = null;
    try {
      await saveEncryptedSandboxState(save);
    } catch (error) {
      reportSocketHandlerError("save-encrypted-sandbox", error, { roomId });
    }
  }
  if (pendingSaves.get(roomId) === pending) pendingSaves.delete(roomId);
  releasePersistence(persistenceBudget);
}

async function setKickCooldown(roomId: string, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + KICK_COOLDOWN_MS);
  await db
    .insert(roomKickCooldownsTable)
    .values({ roomId, userId, expiresAt })
    .onConflictDoUpdate({
      target: [roomKickCooldownsTable.roomId, roomKickCooldownsTable.userId],
      set: { expiresAt },
    });
}

async function hasKickCooldown(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [cooldown] = await db
    .select({ expiresAt: roomKickCooldownsTable.expiresAt })
    .from(roomKickCooldownsTable)
    .where(
      and(
        eq(roomKickCooldownsTable.roomId, roomId),
        eq(roomKickCooldownsTable.userId, userId),
        gt(roomKickCooldownsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!cooldown;
}

async function hasActiveRoomBan(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [ban] = await db
    .select({ id: roomBansTable.id })
    .from(roomBansTable)
    .where(
      and(
        eq(roomBansTable.roomId, roomId),
        eq(roomBansTable.userId, userId),
        or(
          isNull(roomBansTable.expiresAt),
          gt(roomBansTable.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return !!ban;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRoomId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,64}$/.test(value)
    ? value
    : null;
}

function getText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function getSandboxFile(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function getEncryptedPayload(value: unknown, maxLength: number): EncryptedPayload | null {
  const data = getRecord(value);
  const ciphertext = data?.["ciphertext"];
  const nonce = data?.["nonce"];
  if (
    typeof ciphertext !== "string" ||
    typeof nonce !== "string" ||
    ciphertext.length === 0 ||
    ciphertext.length > maxLength ||
    nonce.length === 0 ||
    nonce.length > 128
  ) {
    return null;
  }
  return { ciphertext, nonce };
}

function getAssistantRequestId(value: unknown): string | null {
  return typeof value === "string" && ASSISTANT_REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

function getAssistantRequest(value: unknown): AssistantRequest | null {
  const data = getRecord(value);
  const requestId = getAssistantRequestId(data?.["requestId"]);
  const prompt = getText(data?.["prompt"], MAX_ASSISTANT_PROMPT_LENGTH);
  const files = getRecord(data?.["files"]);
  const html = getSandboxFile(files?.["html"], MAX_ASSISTANT_FILE_LENGTH);
  const css = getSandboxFile(files?.["css"], MAX_ASSISTANT_FILE_LENGTH);
  const js = getSandboxFile(files?.["js"], MAX_ASSISTANT_FILE_LENGTH);

  if (
    !requestId ||
    !prompt ||
    html === null ||
    css === null ||
    js === null ||
    html.length + css.length + js.length > MAX_ASSISTANT_CONTEXT_LENGTH
  ) {
    return null;
  }

  return { requestId, prompt, files: { html, css, js } };
}

export function getRooms() {
  return Array.from(rooms.values()).map((r) => ({
    id: r.id,
    name: r.name,
    userCount: r.users.size,
    createdAt: r.createdAt,
  }));
}

export function broadcastMessageDeletion(roomId: string, messageId: string): void {
  const io = activeServer;
  if (!io) return;
  const room = rooms.get(roomId);
  if (room) {
    room.messages = room.messages.filter((message) => message.id !== messageId);
  }
  io.to(roomId).emit("message-deleted", { roomId, messageId });
}

export function resetSocketRoomStateForTest(): void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error("Socket room state can only be reset by tests.");
  }
  rooms.clear();
  activeServer = null;
}

export async function kickRoomMember(
  roomId: string,
  actorId: string,
  targetId: string,
): Promise<
  "ok" | "room-not-found" | "forbidden" | "protected-target" | "target-not-found"
> {
  const io = activeServer;
  const room = rooms.get(roomId);
  if (!io || !room) return "room-not-found";
  if (actorId === targetId) {
    return "forbidden";
  }

  const [persistedRoom] = await db
    .select({ createdBy: roomsTable.createdBy })
    .from(roomsTable)
    .where(eq(roomsTable.id, roomId))
    .limit(1);
  if (!persistedRoom) return "room-not-found";
  if (persistedRoom.createdBy !== actorId && !isConfiguredAdmin(actorId)) {
    return "forbidden";
  }
  if (isConfiguredAdmin(targetId)) return "protected-target";

  const target = room.users.get(targetId);
  if (!target) return "target-not-found";

  await setKickCooldown(roomId, targetId);
  for (const socketId of [...target.socketIds]) {
    const targetSocket = io.sockets.sockets.get(socketId) as AppSocket | undefined;
    if (!targetSocket) continue;
    targetSocket.emit("kicked", { roomId, userId: targetId });
    leaveRoom(targetSocket, io, roomId);
  }
  return "ok";
}

export async function kickRoomUser(
  roomId: string,
  userId: string,
  banned: boolean,
): Promise<void> {
  const io = activeServer;
  const room = rooms.get(roomId);
  const target = room?.users.get(userId);
  if (!io || !room || !target) return;

  for (const socketId of [...target.socketIds]) {
    const targetSocket = io.sockets.sockets.get(socketId) as AppSocket | undefined;
    if (!targetSocket) continue;
    targetSocket.emit("kicked", { roomId, userId, banned });
    leaveRoom(targetSocket, io, roomId);
  }
}

export function disconnectBannedUser(userId: string): void {
  const io = activeServer;
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const appSocket = socket as AppSocket;
    if (appSocket.data.authenticatedUser?.userId !== userId) continue;
    appSocket.emit("access-revoked", { reason: "banned" });
    appSocket.disconnect(true);
  }
}

export function setupSocketIO(httpServer: HttpServer) {
  const activeAssistantRequests = new Map<string, ActiveAssistantRequest>();
  const lastAssistantRequestAt = new Map<string, number>();
  const connectionRegistry = createConnectionRegistry();
  const eventBudgetRegistry = createEventBudgetRegistry();
  const persistenceBudget = createPersistenceBudget();
  const pendingSandboxSaves = new Map<string, PendingSandboxSave>();
  const io: AppServer = new Server(httpServer, {
    path: "/api/socket.io",
    cors: { methods: ["GET", "POST"] },
    maxHttpBufferSize: SOCKET_PACKET_MAX_BYTES,
    allowRequest(req, callback) {
      callback(null, isAllowedOrigin(req.headers.origin));
    },
  });
  activeServer = io;

  io.use(async (socket: AppSocket, next) => {
    // Wraps the whole handshake, not just the Clerk-token branch: a failure
    // anywhere here (getAccountAccess giving up on a throttled Clerk,
    // getAccountProfile hitting a down database) must still resolve `next()`
    // and be reported, rather than leaving the middleware's promise to
    // reject silently.
    const lease = reserveConnection(
      connectionRegistry,
      getSocketIp(socket),
    );
    if (!lease) {
      recordSocketAuthFailure("connection_limit");
      next(new Error("Too many realtime connections. Please try again."));
      return;
    }
    socket.data.connectionLease = lease;

    try {
      const auth = getRecord(socket.handshake.auth);
      const token = typeof auth?.["token"] === "string" ? auth["token"] : "";
      if (!token) {
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          "Authentication required.",
          "missing_token",
        );
        return;
      }

      const capability = verifyRoomAccessCapability(token);
      if (capability) {
        const access = await getAccountAccess(capability.userId);
        if (!access.allowed) {
          rejectHandshake(
            next,
            connectionRegistry,
            lease,
            access.reason === "banned"
              ? "Your RealtimeAlgoChatApp Studio account has been banned."
              : "Verify your email before entering RealtimeAlgoChatApp Studio.",
            access.reason === "banned" ? "banned" : "unverified_email",
          );
          return;
        }
        if (
          !reserveAccountConnection(
            connectionRegistry,
            lease,
            capability.userId,
          )
        ) {
          rejectHandshake(
            next,
            connectionRegistry,
            lease,
            "Too many realtime connections for this account. Please close another connection first.",
            "connection_limit",
          );
          return;
        }
        socket.data.authenticatedUser = {
          userId: capability.userId,
          username: capability.username,
          avatarEmoji: capability.avatarEmoji,
          purpose: capability.purpose,
          restrictedRoomId: capability.roomId,
        };
        next();
        return;
      }

      let verifiedToken: Awaited<ReturnType<typeof verifyToken>>;
      try {
        verifiedToken = await verifyToken(token, {
          secretKey: process.env["CLERK_SECRET_KEY"],
        });
      } catch {
        // An invalid, expired, or malformed token is an expected, routine
        // auth rejection (every returning user with a stale session hits
        // this) -- not a bug. Count it for rate monitoring but do not file
        // a Sentry exception per bad handshake.
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          "Invalid session.",
          "invalid_session",
        );
        return;
      }

      const userId = verifiedToken?.sub;
      if (typeof userId !== "string" || !userId) {
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          "Invalid session.",
          "invalid_session",
        );
        return;
      }
      const access = await getAccountAccess(userId);
      if (!access.allowed) {
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          access.reason === "banned"
            ? "Your RealtimeAlgoChatApp Studio account has been banned."
            : "Verify your email before entering RealtimeAlgoChatApp Studio.",
          access.reason === "banned" ? "banned" : "unverified_email",
        );
        return;
      }
      if (!reserveAccountConnection(connectionRegistry, lease, userId)) {
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          "Too many realtime connections for this account. Please close another connection first.",
          "connection_limit",
        );
        return;
      }
      const profile = await getAccountProfile(userId);

      socket.data.authenticatedUser = {
        userId,
        username: profile.username,
        avatarEmoji: profile.avatarEmoji,
        purpose: "chat",
      };
      next();
    } catch (error) {
      if (error instanceof AccountAccessUnavailableError) {
        // Clerk could not answer within the lookup's retry budget, on either
        // the room-capability or the Clerk-token branch above. That is an
        // upstream condition rather than a handler bug, so it is logged and
        // counted toward the auth-failure rate alert instead of filed as a
        // Sentry exception per handshake. The client gets the same retry
        // hint the HTTP 503 carries in Retry-After, so it can reconnect
        // deliberately instead of guessing.
        logger.warn(
          { err: error, retryAfterSeconds: error.retryAfterSeconds },
          "Account access check failed during socket handshake",
        );
        rejectHandshake(
          next,
          connectionRegistry,
          lease,
          ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
          "account_access_unavailable",
          {
            code: ACCOUNT_ACCESS_UNAVAILABLE_CODE,
            retryAfterSeconds: error.retryAfterSeconds,
          },
        );
        return;
      }
      // Reaching here means something other than an expected auth
      // rejection broke (capability parsing, getAccountProfile throwing,
      // etc.) -- a real bug or infra failure, so it gets a Sentry exception
      // in addition to counting toward the auth-failure rate.
      reportSocketHandlerError("connection-auth", error);
      releaseConnection(connectionRegistry, lease);
      recordSocketAuthFailure("unexpected_error");
      next(new Error("Invalid session."));
    }
  });

  io.on("connection", (socket: AppSocket) => {
    try {
      setupConnectedSocket(
        socket,
        io,
        activeAssistantRequests,
        lastAssistantRequestAt,
        eventBudgetRegistry,
        persistenceBudget,
        pendingSandboxSaves,
        connectionRegistry,
      );
    } catch (error) {
      reportSocketHandlerError("connection", error, { sid: socket.id });
      releaseConnection(connectionRegistry, socket.data.connectionLease);
      socket.disconnect(true);
    }
  });

  return io;
}

function setupConnectedSocket(
  socket: AppSocket,
  io: AppServer,
  activeAssistantRequests: Map<string, ActiveAssistantRequest>,
  lastAssistantRequestAt: Map<string, number>,
  eventBudgetRegistry: EventBudgetRegistry,
  persistenceBudget: PersistenceBudget,
  pendingSandboxSaves: Map<string, PendingSandboxSave>,
  connectionRegistry: ConnectionRegistry,
): void {
  const authenticatedUser = socket.data.authenticatedUser;
  if (!authenticatedUser) {
    releaseConnection(connectionRegistry, socket.data.connectionLease);
    socket.disconnect(true);
    return;
  }
  logger.info({ sid: socket.id, userId: authenticatedUser.userId }, "socket connected");

  const finishAssistantRequest = (requestId: string, cancelled = false) => {
    const active = activeAssistantRequests.get(socket.id);
    if (!active || active.requestId !== requestId) return;
    clearTimeout(active.timeout);
    activeAssistantRequests.delete(socket.id);
    socket.emit("assistant-done", { requestId, cancelled });
  };

  const abortAssistantRequest = (notifyClient = false) => {
    const active = activeAssistantRequests.get(socket.id);
    if (!active) return;
    active.controller.abort();
    clearTimeout(active.timeout);
    activeAssistantRequests.delete(socket.id);
    if (notifyClient) {
      socket.emit("assistant-done", {
        requestId: active.requestId,
        cancelled: true,
      });
    }
  };

  // Streams one already-validated, disclosure-acknowledged request. Only the
  // prompt and the current sandbox files reach the model: never chat
  // messages, the room key, or the capability token (none of which the
  // handler even receives). Every exit path settles the client exactly once:
  // "assistant-done" for completion or cancellation, "assistant-error" for a
  // timeout, rate limit, or service failure.
  const startAssistantRequest = (roomId: string, request: AssistantRequest) => {
    const { requestId } = request;
    const controller = new AbortController();
    const isCurrent = () =>
      activeAssistantRequests.get(socket.id)?.requestId === requestId;
    const timeout = setTimeout(() => {
      if (!isCurrent()) return;
      activeAssistantRequests.delete(socket.id);
      controller.abort();
      socket.emit("assistant-error", {
        requestId,
        code: "TIMEOUT",
        message: `The assistant did not finish within ${ASSISTANT_TIMEOUT_MS / 1000} seconds. Any partial answer is kept; please try again.`,
      });
    }, ASSISTANT_TIMEOUT_MS);
    activeAssistantRequests.set(socket.id, { requestId, controller, timeout });

    streamSandboxAssistant({
      prompt: request.prompt,
      files: request.files,
      signal: controller.signal,
      onText: (text) => {
        if (!isCurrent()) return;
        socket.emit("assistant-chunk", { requestId, text });
      },
    })
      .then(() => finishAssistantRequest(requestId))
      .catch((error: unknown) => {
        // A cancelled, timed-out, left, or disconnected request was already
        // settled by whoever aborted it.
        if (!isCurrent()) return;
        clearTimeout(timeout);
        activeAssistantRequests.delete(socket.id);
        if (isAnthropicRateLimitError(error)) {
          const retryAfterSeconds = getAssistantRateLimitCountdown(
            getAnthropicRetryAfterSeconds(error),
          );
          socket.emit("assistant-error", {
            requestId,
            code: "RATE_LIMITED",
            retryAfterSeconds,
            message: `The AI service is rate limited right now. You can ask again in ${retryAfterSeconds} seconds.`,
          });
          return;
        }
        reportSocketHandlerError("assistant-request", error, {
          roomId,
          userId: authenticatedUser.userId,
          requestId,
        });
        socket.emit("assistant-error", {
          requestId,
          code: "SERVICE_ERROR",
          message:
            "The AI service could not answer right now. Please try again in a moment.",
        });
      });
  };

  let roomJoinInFlight = false;
  socket.on("join-room", async (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
    if (roomJoinInFlight) return;
    roomJoinInFlight = true;
    const roomHydrationRelease: { current?: () => void } = {};
    let coldHydrationRoom: Room | null = null;
    let coldHydrationVerified = false;
    try {
      const data = getRecord(payload);
      const roomId = getRoomId(data?.["roomId"]);
      if (!roomId) {
        socket.emit("error", { message: "Invalid room." });
        return;
      }
      if (
        authenticatedUser.restrictedRoomId &&
        authenticatedUser.restrictedRoomId !== roomId
      ) {
        socket.emit("error", { message: "This room access session is restricted." });
        return;
      }

      if (await hasActiveRoomBan(roomId, authenticatedUser.userId)) {
        socket.emit("error", {
          code: "ROOM_BANNED",
          message: "You are banned from this room",
        });
        return;
      }

      if (await hasKickCooldown(roomId, authenticatedUser.userId)) {
        socket.emit("error", {
          message:
            "You were recently removed from this room. Please wait a few minutes before rejoining.",
        });
        return;
      }

      const currentRoomId = socket.data.roomId;
      if (currentRoomId && currentRoomId !== roomId) {
        leaveRoom(socket, io, currentRoomId);
      }

      let coldHydrated = false;
      const pendingHydration = roomHydrationGates.get(roomId);
      if (pendingHydration) {
        await pendingHydration;
        if (!rooms.has(roomId)) {
          throw new Error("Room hydration did not complete.");
        }
      }
      if (!rooms.has(roomId)) {
        let releaseGate!: () => void;
        const hydrationGate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        roomHydrationGates.set(roomId, hydrationGate);
        roomHydrationRelease.current = () => {
          if (roomHydrationGates.get(roomId) === hydrationGate) {
            roomHydrationGates.delete(roomId);
          }
          releaseGate();
        };
        const requestedName = getText(data?.["roomName"], 60) ?? roomId;
        if (data?.["createIfMissing"] !== false) {
          await db
            .insert(roomsTable)
            .values({
              id: roomId,
              name: requestedName,
              createdBy: authenticatedUser.userId,
            })
            .onConflictDoNothing();
        }
        const [persistedRoom] = await db
          .select({
            name: roomsTable.name,
            createdBy: roomsTable.createdBy,
            createdAt: roomsTable.createdAt,
          })
          .from(roomsTable)
          .where(eq(roomsTable.id, roomId))
          .limit(1);
        if (!persistedRoom) {
          socket.emit("error", { message: "Room not found." });
          return;
        }
          let persistedMessages: Awaited<ReturnType<typeof loadEncryptedMessages>> = [];
          let persistedSandbox: Awaited<ReturnType<typeof loadEncryptedSandboxState>> = null;
          try {
            [persistedMessages, persistedSandbox] = await Promise.all([
              loadEncryptedMessages(roomId),
              loadEncryptedSandboxState(roomId),
            ]);
          } catch (error) {
            reportSocketHandlerError("load-encrypted-room-state", error, { roomId });
          }
          rooms.set(roomId, {
          id: roomId,
          name: persistedRoom.name,
          createdByUserId: persistedRoom.createdBy,
          users: new Map(),
           messages: persistedMessages.map((message) => ({
             id: message.id,
             ciphertext: message.ciphertext ?? undefined,
             nonce: message.nonce ?? undefined,
             content: message.systemContent ?? undefined,
             userId: message.userId,
             username: message.username,
             avatarEmoji: DEFAULT_AVATAR_EMOJI,
             timestamp: Number(message.timestamp),
             type: message.type,
           })),
           sandboxState: persistedSandbox,
          createdAt: persistedRoom.createdAt.getTime(),
        });
          coldHydrationRoom = rooms.get(roomId) ?? null;
          coldHydrated = true;
      }

      const room = rooms.get(roomId);
      if (!room) {
        throw new Error("Room hydration did not complete.");
      }
      const existingUser = room.users.get(authenticatedUser.userId);
      const isNewSocketInRoom = !existingUser?.socketIds.has(socket.id);
      if (isNewSocketInRoom && getRoomSocketCount(room) >= ROOM_SOCKET_MAX) {
        socket.emit("error", {
          code: "ROOM_CAPACITY",
          message: "This room has reached its realtime connection limit.",
        });
        return;
      }
      if (
        isNewSocketInRoom &&
        authenticatedUser.purpose === "call" &&
        !hasCallParticipant(io, room, authenticatedUser.userId) &&
        getCallParticipantCount(io, room) >= CALL_PARTICIPANTS_MAX
      ) {
        socket.emit("error", {
          code: "CALL_CAPACITY",
          message: "This call has reached its participant limit.",
        });
        return;
      }
      const isNewPresence = !existingUser;
      const previousPublicKey = existingUser?.publicKey ?? null;
      let publicKey: string | null = null;
      try {
        publicKey = await getPublicKey(authenticatedUser.userId);
      } catch (error) {
        reportSocketHandlerError("load-public-key", error, {
          roomId,
          userId: authenticatedUser.userId,
        });
      }
      const user =
        existingUser ?? {
          userId: authenticatedUser.userId,
          username: authenticatedUser.username,
          avatarEmoji: authenticatedUser.avatarEmoji,
          publicKey,
          socketIds: new Set<string>(),
        };
      user.username = authenticatedUser.username;
      user.avatarEmoji = authenticatedUser.avatarEmoji;
      user.publicKey = publicKey;
      user.socketIds.add(socket.id);
      room.users.set(user.userId, user);
      socket.join(roomId);
      socket.data.roomId = roomId;

      // A deletion can commit after cold hydration reads active rows but before
      // this socket joins the room and can receive its live tombstone. Recheck
      // the bounded hydrated window once delivery is attached. Deletions after
      // this point are covered by the live event.
      if (coldHydrated) {
        if (room.messages.length > 0) {
          const checkedMessageIds = room.messages
            .filter((message) => message.type === "text")
            .map((message) => message.id);
          const checkedMessageIdSet = new Set(checkedMessageIds);
          const activeMessageIds = await keepActiveMessageIds(
            roomId,
            checkedMessageIds,
          );
          room.messages = room.messages.filter(
            (message) =>
              message.type === "system" ||
              !checkedMessageIdSet.has(message.id) ||
              activeMessageIds.has(message.id),
          );
        }
        coldHydrationVerified = true;
        roomHydrationRelease.current?.();
        roomHydrationRelease.current = undefined;
      }

      const replayAfterMessageId = getText(data?.["lastSeenMessageId"], 120);
      const replayCursorIndex = replayAfterMessageId
        ? room.messages.findIndex((message) => message.id === replayAfterMessageId)
        : -1;
      const replayGap = !!replayAfterMessageId && replayCursorIndex === -1;
      const replayMessages =
        replayAfterMessageId && replayCursorIndex >= 0
          ? room.messages.slice(replayCursorIndex + 1)
          : room.messages.slice(-80);

      socket.emit("room-joined", {
        roomId,
        roomName: room.name,
        messages: replayMessages,
        replayAfterMessageId,
        replayGap,
        users: getRoomMembers(io, room, authenticatedUser.purpose).map((member) => ({
          userId: member.userId,
          username: member.username,
          avatarEmoji: member.avatarEmoji,
           publicKey: member.publicKey,
        })),
        canModerate:
          room.createdByUserId === user.userId || isConfiguredAdmin(user.userId),
         sandboxState: room.sandboxState,
         keyEnvelope: await getRoomEnvelope(roomId, authenticatedUser.userId).catch(() => null),
      });

      if (isNewPresence) {
        const sysMsg = makeSystemMsg(`${user.username} joined`);
        room.messages.push(sysMsg);
        emitRoomEvent(io, room, "user-joined", {
          userId: user.userId,
          username: user.username,
          avatarEmoji: user.avatarEmoji,
           publicKey: user.publicKey,
          message: sysMsg,
        }, socket.id);
      } else if (publicKey && publicKey !== previousPublicKey) {
        // Presence is per account, so while another session of this account
        // stays in the room no `user-joined` fires. Peers still have to learn
        // that the registered device key changed (for example after a device
        // key reset): the stored envelope targets the old key, and only the
        // creator can deliver a fresh one to the new key.
        emitRoomEvent(io, room, "user-key-changed", {
          roomId,
          userId: user.userId,
          username: user.username,
          publicKey,
        }, socket.id);
        logger.info({ roomId, userId: user.userId }, "member device key changed");
      }
      logger.info({ roomId, userId: user.userId }, "user joined room");
    } catch (error) {
      reportSocketHandlerError("join-room", error, {
        sid: socket.id,
        userId: authenticatedUser.userId,
      });
      socket.emit("error", { message: "Unable to join this room. Please try again." });
    } finally {
      if (
        roomHydrationRelease.current &&
        !coldHydrationVerified &&
        coldHydrationRoom &&
        rooms.get(coldHydrationRoom.id) === coldHydrationRoom
      ) {
        rooms.delete(coldHydrationRoom.id);
        socket.leave(coldHydrationRoom.id);
        if (socket.data.roomId === coldHydrationRoom.id) {
          delete socket.data.roomId;
        }
      }
      roomHydrationRelease.current?.();
      roomJoinInFlight = false;
    }
  });

  let messageRecoveryInFlight = false;
  socket.on("recover-messages", async (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
    if (messageRecoveryInFlight) return;
    messageRecoveryInFlight = true;
    const data = getRecord(payload);
    const requestId = getText(data?.["requestId"], 100);
    const roomId = getRoomId(data?.["roomId"]);
    const afterMessageId = getText(data?.["afterMessageId"], 200);
    const afterTimestamp = data?.["afterTimestamp"];
    const rawDeletedAfter = data?.["deletedAfter"];
    const deletedAfter =
      typeof rawDeletedAfter === "number" &&
      Number.isSafeInteger(rawDeletedAfter) &&
      rawDeletedAfter >= 0
        ? rawDeletedAfter
        : Date.now();
    const deletedAfterId = getText(data?.["deletedAfterId"], 200) ?? "";
    try {
      if (
        !requestId ||
        !roomId ||
        !afterMessageId ||
        typeof afterTimestamp !== "number" ||
        !Number.isSafeInteger(afterTimestamp) ||
        afterTimestamp < 0 ||
        socket.data.roomId !== roomId ||
        !socket.rooms.has(roomId)
      ) {
        socket.emit("message-recovery-error", {
          requestId,
          code: "INVALID_RECOVERY_REQUEST",
        });
        return;
      }
      if (await hasActiveRoomBan(roomId, authenticatedUser.userId)) {
        socket.emit("message-recovery-error", {
          requestId,
          code: "ROOM_BANNED",
        });
        return;
      }
      const [page, deletionPage] = await Promise.all([
        loadEncryptedMessagesAfter(
          roomId,
          { id: afterMessageId, timestamp: afterTimestamp },
          MESSAGE_RECOVERY_PAGE_SIZE,
        ),
        loadDeletedMessageIdsAfter(
          roomId,
          { id: deletedAfterId, deletedAt: deletedAfter },
          MESSAGE_RECOVERY_PAGE_SIZE,
        ),
      ]);
      if (
        socket.data.roomId !== roomId ||
        !socket.rooms.has(roomId) ||
        (await hasActiveRoomBan(roomId, authenticatedUser.userId))
      ) {
        socket.emit("message-recovery-error", {
          requestId,
          code: "ROOM_ACCESS_REVOKED",
        });
        return;
      }
      const messages = page.messages.map((message) => ({
        id: message.id,
        ciphertext: message.ciphertext ?? undefined,
        nonce: message.nonce ?? undefined,
        content: message.systemContent ?? undefined,
        userId: message.userId,
        username: message.username,
        avatarEmoji: DEFAULT_AVATAR_EMOJI,
        timestamp: Number(message.timestamp),
        type: message.type,
      }));
      socket.emit("message-recovery-page", {
        requestId,
        messages,
        deletedMessageIds: deletionPage.tombstones.map((item) => item.id),
        hasMore: page.hasMore || deletionPage.hasMore,
        nextCursor: messages.at(-1)
          ? {
              id: messages.at(-1)!.id,
              timestamp: messages.at(-1)!.timestamp,
            }
          : { id: afterMessageId, timestamp: afterTimestamp },
        nextDeletionCursor: deletionPage.tombstones.at(-1) ?? {
          id: deletedAfterId,
          deletedAt: deletedAfter,
        },
      });
    } catch (error) {
      reportSocketHandlerError("recover-messages", error, {
        roomId,
        userId: authenticatedUser.userId,
      });
      socket.emit("message-recovery-error", {
        requestId,
        code: "RECOVERY_FAILED",
      });
    } finally {
      messageRecoveryInFlight = false;
    }
  });

    socket.on("assistant-request", (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
      if (authenticatedUser.purpose !== "sandbox") {
        socket.emit("assistant-error", {
          message: "This session cannot use the coding assistant.",
        });
        return;
      }
      const data = getRecord(payload);
      const requestId = getAssistantRequestId(data?.["requestId"]) ?? undefined;
      const rejectAssistantRequest = (error: AssistantErrorPayload) => {
        socket.emit("assistant-error", { requestId, ...error });
      };

      // Privacy gate first. The room is end-to-end encrypted and the model can
      // only answer readable code, so a request is refused before anything
      // else in it is inspected unless the user confirmed the disclosure
      // notice on the client. Nothing below runs without it.
      if (data?.[ASSISTANT_DISCLOSURE_FIELD] !== true) {
        rejectAssistantRequest({
          code: "DISCLOSURE_REQUIRED",
          message: ASSISTANT_DISCLOSURE_REQUIRED_MESSAGE,
        });
        return;
      }

      const roomId = getRoomId(data?.["roomId"]);
      const room = roomId ? getJoinedRoom(socket, roomId) : null;
      if (!room) {
        rejectAssistantRequest({
          code: "NOT_IN_ROOM",
          message: "Join the sandbox room before asking the assistant.",
        });
        return;
      }

      const request = getAssistantRequest(payload);
      if (!request) {
        rejectAssistantRequest({
          code: "INVALID_REQUEST",
          message: `Ask a question of up to ${formatCount(MAX_ASSISTANT_PROMPT_LENGTH)} characters, with each sandbox file under ${formatCount(MAX_ASSISTANT_FILE_LENGTH)} characters and ${formatCount(MAX_ASSISTANT_CONTEXT_LENGTH)} characters in total.`,
        });
        return;
      }

      if (activeAssistantRequests.has(socket.id)) {
        rejectAssistantRequest({
          code: "REQUEST_IN_PROGRESS",
          message: "Wait for the current reply to finish, or stop it first.",
        });
        return;
      }

      const now = Date.now();
      const lastRequestAt = lastAssistantRequestAt.get(socket.id);
      const sinceLastRequest =
        lastRequestAt === undefined ? Number.POSITIVE_INFINITY : now - lastRequestAt;
      if (sinceLastRequest < ASSISTANT_REQUEST_COOLDOWN_MS) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((ASSISTANT_REQUEST_COOLDOWN_MS - sinceLastRequest) / 1000),
        );
        rejectAssistantRequest({
          code: "COOLDOWN",
          retryAfterSeconds,
          message: `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} before asking again.`,
        });
        return;
      }
      lastAssistantRequestAt.set(socket.id, now);
      startAssistantRequest(room.id, request);
    });

    socket.on("assistant-cancel", (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
      const data = getRecord(payload);
      const requestId = data?.["requestId"];
      const roomId = getRoomId(data?.["roomId"]);
      const active = activeAssistantRequests.get(socket.id);
      if (
        authenticatedUser.purpose !== "sandbox" ||
        typeof requestId !== "string" ||
        roomId !== socket.data.roomId ||
        active?.requestId !== requestId
      ) {
        return;
      }
      abortAssistantRequest(true);
    });

    socket.on("message", async (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
      if (authenticatedUser.purpose !== "chat") return;
      const data = getRecord(payload);
      const roomId = getRoomId(data?.["roomId"]);
       const encrypted = getEncryptedPayload(payload, 12_000);
      const room = roomId ? getJoinedRoom(socket, roomId) : null;
       if (!room || !roomId || !encrypted) return;
      if (!reservePersistence(persistenceBudget)) {
        socket.emit("error", {
          code: "PERSISTENCE_BUSY",
          message: "Realtime storage is busy. Please try again shortly.",
        });
        return;
      }
      const msg: Message = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
         ciphertext: encrypted.ciphertext,
         nonce: encrypted.nonce,
        userId: authenticatedUser.userId,
        username: authenticatedUser.username,
        avatarEmoji: authenticatedUser.avatarEmoji,
        timestamp: Date.now(),
        type: "text",
      };
      try {
        await saveEncryptedMessage({
          id: msg.id,
          roomId: room.id,
          userId: authenticatedUser.userId,
          username: authenticatedUser.username,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          timestamp: msg.timestamp,
        });
        room.messages.push(msg);
        if (room.messages.length > 200) room.messages = room.messages.slice(-200);
        emitRoomEvent(io, room, "message", msg);
      } catch (error) {
         reportSocketHandlerError("save-encrypted-message", error, {
           roomId: room.id,
         });
        socket.emit("error", {
          code: "MESSAGE_NOT_SAVED",
          message: "Unable to save this message. Please try again.",
        });
      } finally {
        releasePersistence(persistenceBudget);
      }
    });

    socket.on("sandbox-update", (payload: unknown) => {
    if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
      if (authenticatedUser.purpose !== "sandbox") return;
       const data = getRecord(payload);
       const roomId = getRoomId(data?.["roomId"]);
       const encrypted = getEncryptedPayload(payload, 420_000);
      const room = roomId ? getJoinedRoom(socket, roomId) : null;
       if (!room || !encrypted) return;
       if (!queueSandboxSave(pendingSandboxSaves, persistenceBudget, {
         roomId: room.id,
         ciphertext: encrypted.ciphertext,
         nonce: encrypted.nonce,
         updatedBy: authenticatedUser.userId,
       })) {
         socket.emit("error", {
           code: "PERSISTENCE_BUSY",
           message: "Realtime storage is busy. Please try again shortly.",
         });
         return;
       }
       room.sandboxState = encrypted;
       emitRoomEvent(io, room, "sandbox-update", encrypted, socket.id);
    });

     socket.on("room-key-envelope", async (payload: unknown) => {
      if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
       const data = getRecord(payload);
       const roomId = getRoomId(data?.["roomId"]);
       const targetUserId = getText(data?.["targetUserId"], 128);
       const encrypted = getEncryptedPayload(payload, 1_000);
       const senderPublicKey = getText(data?.["senderPublicKey"], 128);
       const room = roomId ? getJoinedRoom(socket, roomId) : null;
       if (
         !room ||
         !targetUserId ||
         !senderPublicKey ||
         !encrypted ||
         !room.users.has(targetUserId) ||
         // Recovery envelopes are the room creator's key authority. A joined
         // member must not be able to replace another member's backup key.
         authenticatedUser.userId !== room.createdByUserId
       ) {
         return;
       }
      if (!reservePersistence(persistenceBudget)) {
        socket.emit("error", {
          code: "PERSISTENCE_BUSY",
          message: "Realtime storage is busy. Please try again shortly.",
        });
        return;
      }
       try {
         const registration = await getPublicKeyRecord(authenticatedUser.userId);
         const isRegisteredKey =
           registration.publicKey !== null && registration.publicKey === senderPublicKey;
         // Device-key handover: after another device of the creator's account
         // took over the registration, a creator session that still holds the
         // room key hands it to the account's new key. Only the key the
         // registry recorded as displaced is accepted, and only for the
         // creator's own account, so a superseded session never becomes the
         // key authority for other members.
         const isHandover =
           !isRegisteredKey &&
           targetUserId === authenticatedUser.userId &&
           registration.previousPublicKey !== null &&
           registration.previousPublicKey === senderPublicKey;
         if (!isRegisteredKey && !isHandover) {
           return;
         }
         await saveRoomEnvelope({
         roomId: room.id,
           userId: targetUserId,
           ciphertext: encrypted.ciphertext,
           nonce: encrypted.nonce,
           senderPublicKey,
         });
       } catch (error) {
         reportSocketHandlerError("save-room-key-envelope", error, { roomId });
         return;
      } finally {
        releasePersistence(persistenceBudget);
       }
       const target = room.users.get(targetUserId);
       if (!target) return;
       for (const targetSocketId of target.socketIds) {
         // The sending session cannot open its own envelope.
         if (targetSocketId === socket.id) continue;
         io.to(targetSocketId).emit("room-key-envelope", {
           roomId,
           ciphertext: encrypted.ciphertext,
           nonce: encrypted.nonce,
           senderPublicKey,
         });
       }
     });

    socket.on("webrtc-offer", (payload: unknown) => {
      relayWebRtc(
        socket,
        io,
        "webrtc-offer",
        "offer",
        payload,
        eventBudgetRegistry,
      );
    });
    socket.on("webrtc-answer", (payload: unknown) => {
      relayWebRtc(
        socket,
        io,
        "webrtc-answer",
        "answer",
        payload,
        eventBudgetRegistry,
      );
    });
    socket.on("webrtc-ice", (payload: unknown) => {
      relayWebRtc(
        socket,
        io,
        "webrtc-ice",
        "candidate",
        payload,
        eventBudgetRegistry,
      );
    });

    socket.on("leave-room", (payload: unknown) => {
      if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
      const data = getRecord(payload);
      const roomId = getRoomId(data?.["roomId"]);
      if (roomId) {
        abortAssistantRequest();
        leaveRoom(socket, io, roomId);
      }
    });

  socket.on("disconnect", (reason: string) => {
    recordSocketDisconnect(reason);
    releaseConnection(connectionRegistry, socket.data.connectionLease);
    const userId = authenticatedUser.userId;
    if ((connectionRegistry.byUser.get(userId) ?? 0) === 0) {
      eventBudgetRegistry.byUser.delete(userId);
    }
    abortAssistantRequest();
    lastAssistantRequestAt.delete(socket.id);
    if (socket.data.roomId) leaveRoom(socket, io, socket.data.roomId);
    logger.info({ sid: socket.id, reason }, "socket disconnected");
  });
}

function getJoinedRoom(socket: AppSocket, roomId: string): Room | null {
  const userId = socket.data.authenticatedUser?.userId;
  const room = rooms.get(roomId);
  if (
    !userId ||
    !room ||
    socket.data.roomId !== roomId ||
    !socket.rooms.has(roomId) ||
    !room.users.get(userId)?.socketIds.has(socket.id)
  ) {
    return null;
  }
  return room;
}

function getRoomSocketCount(room: Room): number {
  let count = 0;
  for (const user of room.users.values()) count += user.socketIds.size;
  return count;
}

function hasCallParticipant(
  io: AppServer,
  room: Room,
  userId: string,
): boolean {
  const user = room.users.get(userId);
  if (!user) return false;
  return [...user.socketIds].some((socketId) => {
    const memberSocket = io.sockets.sockets.get(socketId) as AppSocket | undefined;
    return memberSocket?.data.authenticatedUser?.purpose === "call";
  });
}

function getCallParticipantCount(io: AppServer, room: Room): number {
  let count = 0;
  for (const user of room.users.values()) {
    if (hasCallParticipant(io, room, user.userId)) count += 1;
  }
  return count;
}

function getRoomMembers(
  io: AppServer,
  room: Room,
  purpose: SessionPurpose,
): User[] {
  if (purpose !== "call") return Array.from(room.users.values());
  return Array.from(room.users.values()).filter((user) =>
    hasCallParticipant(io, room, user.userId),
  );
}

function leaveRoom(socket: AppSocket, io: AppServer, roomId: string) {
  const room = rooms.get(roomId);
  const userId = socket.data.authenticatedUser?.userId;
  if (!room || !userId) return;
  const user = room.users.get(userId);
  if (!user) return;
  user.socketIds.delete(socket.id);
  socket.leave(roomId);
  if (socket.data.roomId === roomId) socket.data.roomId = undefined;
  if (user.socketIds.size > 0) return;
  room.users.delete(userId);
  if (room.users.size === 0) {
    rooms.delete(roomId);
    return;
  }
  const sysMsg = makeSystemMsg(`${user.username} left`);
  room.messages.push(sysMsg);
  emitRoomEvent(io, room, "user-left", {
    userId,
    username: user.username,
    message: sysMsg,
  });
}

function emitRoomEvent(
  io: AppServer,
  room: Room,
  event: string,
  payload: unknown,
  excludedSocketId?: string,
): void {
  let recipients = 0;
  for (const user of room.users.values()) {
    for (const socketId of user.socketIds) {
      if (socketId === excludedSocketId) continue;
      if (recipients >= ROOM_EVENT_MAX_RECIPIENTS) return;
      io.to(socketId).emit(event, payload);
      recipients += 1;
    }
  }
}

function relayWebRtc(
  socket: AppSocket,
  io: AppServer,
  event: "webrtc-offer" | "webrtc-answer" | "webrtc-ice",
  field: "offer" | "answer" | "candidate",
  payload: unknown,
  eventBudgetRegistry: EventBudgetRegistry,
) {
  const authenticatedUser = socket.data.authenticatedUser;
  if (!authenticatedUser || authenticatedUser.purpose !== "call") return;
  if (!consumeEventBudget(socket, eventBudgetRegistry, payload)) return;
  const data = getRecord(payload);
  const roomId = getRoomId(data?.["roomId"]);
  const targetUserId = getText(data?.["to"], 128);
  const room = roomId ? getJoinedRoom(socket, roomId) : null;
  const signal = getWebRtcSignal(data?.[field]);
  if (!room || !targetUserId || !signal) return;

  const targetUser = room.users.get(targetUserId);
  if (!targetUser) return;
  let recipients = 0;
  for (const targetSocketId of targetUser.socketIds) {
    if (recipients >= WEBRTC_MAX_RECIPIENTS) break;
    io.to(targetSocketId).emit(event, {
      roomId,
      from: authenticatedUser.userId,
      [field]: signal,
    });
    recipients += 1;
  }
}

function getWebRtcSignal(value: unknown): Record<string, unknown> | null {
  const signal = getRecord(value);
  if (!signal || serializedByteLength(signal) > WEBRTC_SIGNAL_MAX_BYTES) {
    return null;
  }
  return signal;
}

function makeSystemMsg(content: string): Message {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content, userId: "system", username: "System",
    avatarEmoji: DEFAULT_AVATAR_EMOJI,
    timestamp: Date.now(), type: "system",
  };
}
