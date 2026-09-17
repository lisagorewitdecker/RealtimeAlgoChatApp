import { Router } from "express";
import { db, messagesTable, roomBansTable, roomsTable } from "@workspace/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  isConfiguredAdmin,
  setAccountBan,
} from "../lib/accountAccess";
import { normalizeAccountSearchQuery, searchAccounts } from "../lib/accountProfile";
import {
  listModerationActions,
  recordMessageDeletion,
  recordModerationAction,
} from "../lib/moderationHistory";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import {
  broadcastMessageDeletion,
  disconnectBannedUser,
  kickRoomMember,
  kickRoomUser,
} from "../socket";
import { createIpRateLimit } from "../middlewares/rateLimit";

const router = Router();
const MODERATION_HISTORY_WINDOW_MS = 60 * 1_000;
const MODERATION_HISTORY_PER_USER_WINDOW = 30;
const MODERATION_HISTORY_PER_IP_WINDOW = 120;
const MODERATION_HISTORY_TRACKING_KEY_LIMIT = 10_000;
const moderationRateLimit = createIpRateLimit({
  scope: "moderation-routes",
  windowMs: 60_000,
  maxRequests: 120,
});

interface ModerationHistoryWindow {
  startedAt: number;
  count: number;
}

const moderationHistoryByUser = new Map<string, ModerationHistoryWindow>();
const moderationHistoryByIp = new Map<string, ModerationHistoryWindow>();

router.use(moderationRateLimit);

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

router.get("/search", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  if (!isConfiguredAdmin(actorId)) {
    res.status(403).json({ error: "Administrator permission required." });
    return;
  }
  const query = normalizeAccountSearchQuery(req.query["query"]);
  if (!query) {
    res.status(400).json({ error: "Enter at least 2 characters to search." });
    return;
  }

  try {
    res.json({ results: await searchAccounts(query) });
  } catch (error) {
    next(error);
  }
});

router.get("/history", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  if (!isConfiguredAdmin(actorId)) {
    res.status(403).json({ error: "Administrator permission required." });
    return;
  }
  if (!allowModerationHistoryLookup(actorId, req.ip)) {
    res
      .status(429)
      .setHeader("Retry-After", String(MODERATION_HISTORY_WINDOW_MS / 1_000))
      .json({ error: "Too many moderation history requests. Please try again later." });
    return;
  }

  const rawCursor = req.query["cursor"];
  let cursor: number | undefined;
  if (typeof rawCursor === "string" && rawCursor.trim()) {
    const parsed = Number(rawCursor);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "cursor must be a positive integer." });
      return;
    }
    cursor = parsed;
  }

  const targetUserId = req.query["targetUserId"];
  const actorUserId = req.query["actorUserId"];

  try {
    const page = await listModerationActions({
      cursor,
      targetUserId: typeof targetUserId === "string" ? targetUserId.trim() || undefined : undefined,
      actorUserId: typeof actorUserId === "string" ? actorUserId.trim() || undefined : undefined,
    });
    res.json({ actions: page.entries, nextCursor: page.nextCursor });
  } catch (error) {
    next(error);
  }
});

router.post("/:roomId/kick", async (req, res) => {
  const actorId = await requireAuthorizedUser(req, res);
  const roomId = req.params["roomId"];
  const rawTargetId = req.body?.["userId"];
  if (!actorId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(roomId)) {
    res.status(400).json({ error: "A valid room is required." });
    return;
  }
  if (typeof rawTargetId !== "string" || !rawTargetId.trim()) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  const targetId = rawTargetId.trim();

  const result = await kickRoomMember(roomId, actorId, targetId);
  if (result === "ok") {
    res.json({ ok: true });
    return;
  }
  if (result === "room-not-found" || result === "target-not-found") {
    res.status(404).json({ error: "Room member not found." });
    return;
  }
  if (result === "protected-target") {
    res.status(403).json({ error: "Administrators cannot be removed from rooms." });
    return;
  }
  res.status(403).json({ error: "Room creator permission required." });
});

router.delete("/:roomId/messages/:messageId", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  const roomId = req.params["roomId"];
  const messageId = req.params["messageId"];
  if (
    typeof roomId !== "string" ||
    !/^[a-zA-Z0-9_-]{3,64}$/.test(roomId) ||
    typeof messageId !== "string" ||
    !messageId.trim()
  ) {
    res.status(400).json({ error: "A valid room and message are required." });
    return;
  }

  try {
    const [room] = await db
      .select({ createdBy: roomsTable.createdBy })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);
    if (!room || (room.createdBy !== actorId && !isConfiguredAdmin(actorId))) {
      res.status(403).json({ error: "Room creator or admin required" });
      return;
    }
    const [deleted] = await db
      .update(messagesTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(messagesTable.id, messageId),
          eq(messagesTable.roomId, roomId),
          isNull(messagesTable.deletedAt),
        ),
      )
      .returning({ id: messagesTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    void recordMessageDeletion(actorId, roomId, deleted.id);
    broadcastMessageDeletion(roomId, deleted.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/:roomId/ban", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  const roomId = req.params["roomId"];
  const rawTargetId = req.body?.["userId"];
  const reason = req.body?.["reason"];
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(roomId)) {
    res.status(400).json({ error: "A valid room is required." });
    return;
  }
  if (typeof rawTargetId !== "string" || !rawTargetId.trim()) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  const targetId = rawTargetId.trim();

  try {
    const [room] = await db
      .select({ createdBy: roomsTable.createdBy })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);
    const actorIsAdmin = isConfiguredAdmin(actorId);
    if (!room || (room.createdBy !== actorId && !actorIsAdmin)) {
      res.status(403).json({ error: "Room creator or admin required" });
      return;
    }
    if (targetId === actorId) {
      res.status(400).json({ error: "Cannot ban yourself" });
      return;
    }
    if (isConfiguredAdmin(targetId)) {
      res.status(403).json({ error: "Administrators cannot be banned from rooms." });
      return;
    }

    const [activeBan] = await db
      .select({ id: roomBansTable.id })
      .from(roomBansTable)
      .where(
        and(
          eq(roomBansTable.roomId, roomId),
          eq(roomBansTable.userId, targetId),
          or(
            isNull(roomBansTable.expiresAt),
            gt(roomBansTable.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);
    if (activeBan) {
      res.status(409).json({ error: "User is already banned" });
      return;
    }

    const expiresAt = actorIsAdmin
      ? null
      : new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(roomBansTable).values({
      id: makeId(),
      roomId,
      userId: targetId,
      bannedBy: actorId,
      isPermanent: actorIsAdmin,
      expiresAt,
      reason: typeof reason === "string" ? reason.slice(0, 200) : null,
    });
    await kickRoomUser(roomId, targetId, true);
    res.json({ ok: true, isPermanent: actorIsAdmin, expiresAt });
  } catch (error) {
    next(error);
  }
});

router.post("/ban", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  if (!isConfiguredAdmin(actorId)) {
    res.status(403).json({ error: "Administrator permission required." });
    return;
  }
  const rawTargetId = req.body?.["userId"];
  if (typeof rawTargetId !== "string" || !rawTargetId.trim()) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  const targetId = rawTargetId.trim();
  if (targetId === actorId || isConfiguredAdmin(targetId)) {
    res.status(403).json({ error: "Administrator accounts cannot be banned." });
    return;
  }

  try {
    await setAccountBan(targetId, true);
    disconnectBannedUser(targetId);
    res.json({ ok: true });
    void recordModerationAction("ban", actorId, targetId);
  } catch (error) {
    next(error);
  }
});

router.delete("/ban/:userId", async (req, res, next) => {
  const actorId = await requireAuthorizedUser(req, res);
  if (!actorId) return;
  if (!isConfiguredAdmin(actorId)) {
    res.status(403).json({ error: "Administrator permission required." });
    return;
  }
  const targetId = req.params["userId"];
  if (!targetId?.trim()) {
    res.status(400).json({ error: "userId required" });
    return;
  }

  try {
    await setAccountBan(targetId, false);
    res.json({ ok: true });
    void recordModerationAction("restore", actorId, targetId);
  } catch (error) {
    next(error);
  }
});

function allowModerationHistoryLookup(
  userId: string,
  ip: string | undefined,
): boolean {
  const now = Date.now();
  pruneModerationHistoryWindows(now);
  const userWindow = incrementModerationHistoryWindow(
    moderationHistoryByUser,
    userId,
    now,
  );
  const ipKey = ip || "unknown";
  const ipWindow = incrementModerationHistoryWindow(
    moderationHistoryByIp,
    ipKey,
    now,
  );
  const allowed =
    userWindow.count <= MODERATION_HISTORY_PER_USER_WINDOW &&
    ipWindow.count <= MODERATION_HISTORY_PER_IP_WINDOW;
  if (allowed) return true;

  decrementModerationHistoryWindow(moderationHistoryByUser, userId);
  decrementModerationHistoryWindow(moderationHistoryByIp, ipKey);
  return false;
}

function incrementModerationHistoryWindow(
  windows: Map<string, ModerationHistoryWindow>,
  key: string,
  now: number,
): ModerationHistoryWindow {
  const current = windows.get(key);
  if (!current || now - current.startedAt >= MODERATION_HISTORY_WINDOW_MS) {
    const created = { startedAt: now, count: 1 };
    windows.set(key, created);
    return created;
  }
  current.count += 1;
  return current;
}

function decrementModerationHistoryWindow(
  windows: Map<string, ModerationHistoryWindow>,
  key: string,
): void {
  const current = windows.get(key);
  if (!current) return;
  current.count -= 1;
  if (current.count <= 0) windows.delete(key);
}

function pruneModerationHistoryWindows(now: number): void {
  for (const windows of [moderationHistoryByUser, moderationHistoryByIp]) {
    for (const [key, window] of windows) {
      if (now - window.startedAt >= MODERATION_HISTORY_WINDOW_MS) {
        windows.delete(key);
      }
    }
    while (windows.size > MODERATION_HISTORY_TRACKING_KEY_LIMIT) {
      const oldest = findOldestModerationHistoryKey(windows);
      if (typeof oldest !== "string") break;
      windows.delete(oldest);
    }
  }
}

function findOldestModerationHistoryKey(
  windows: Map<string, ModerationHistoryWindow>,
): string | undefined {
  let oldestKey: string | undefined;
  let oldestStartedAt = Number.POSITIVE_INFINITY;
  for (const [key, window] of windows) {
    if (window.startedAt < oldestStartedAt) {
      oldestKey = key;
      oldestStartedAt = window.startedAt;
    }
  }
  return oldestKey;
}

export function resetModerationHistoryRateLimits(): void {
  moderationHistoryByUser.clear();
  moderationHistoryByIp.clear();
}

export default router;
