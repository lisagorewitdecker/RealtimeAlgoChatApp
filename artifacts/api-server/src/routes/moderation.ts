import { Router } from "express";
import { db, roomBansTable, roomsTable } from "@workspace/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  isConfiguredAdmin,
  setAccountBan,
} from "../lib/accountAccess";
import { normalizeAccountSearchQuery, searchAccounts } from "../lib/accountProfile";
import { listModerationActions, recordModerationAction } from "../lib/moderationHistory";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import { disconnectBannedUser, kickRoomMember, kickRoomUser } from "../socket";

const router = Router();

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

export default router;
