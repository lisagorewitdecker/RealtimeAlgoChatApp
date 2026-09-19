/**
 * Admin-only routes for room management.
 *
 * All routes require the caller's userId to appear in the
 * ADMIN_USER_IDS environment variable (comma-separated Clerk IDs).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth";
import { createIpRateLimit } from "../middlewares/rateLimit";
import { db } from "@workspace/db";
import { roomsTable, roomMembersTable, messagesTable } from "@workspace/db";
import { eq, isNull, count, max } from "drizzle-orm";
import { setRoomActiveForModeration } from "../socket";

const router = Router();
const adminRateLimit = createIpRateLimit({
  scope: "admin-routes",
  windowMs: 60_000,
  maxRequests: 120,
});

router.use(adminRateLimit);

function getAdminIds(): Set<string> {
  const raw = process.env["ADMIN_USER_IDS"] ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function requireAdmin(req: Request, res: Response): boolean {
  const userId = (req as AuthRequest).userId;
  if (!getAdminIds().has(userId)) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

/**
 * GET /api/admin/rooms
 * List all rooms with member counts and last-activity timestamps.
 */
router.get("/rooms", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rooms = await db.select().from(roomsTable).orderBy(roomsTable.createdAt);

  // Batch: member counts and last message timestamps
  const memberCounts = await db
    .select({
      roomId: roomMembersTable.roomId,
      count: count(roomMembersTable.userId),
    })
    .from(roomMembersTable)
    .groupBy(roomMembersTable.roomId);

  const lastActivity = await db
    .select({
      roomId: messagesTable.roomId,
      lastAt: max(messagesTable.timestampMs),
    })
    .from(messagesTable)
    .where(isNull(messagesTable.deletedAt))
    .groupBy(messagesTable.roomId);

  const memberMap = new Map(memberCounts.map((r) => [r.roomId, Number(r.count)]));
  const activityMap = new Map(lastActivity.map((r) => [r.roomId, r.lastAt]));

  const result = rooms.map((r) => ({
    id: r.id,
    name: r.name,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
    isActive: r.isActive,
    memberCount: memberMap.get(r.id) ?? 0,
    lastActivityAt: activityMap.get(r.id) ?? null,
  }));

  res.json({ rooms: result });
});

/**
 * DELETE /api/admin/rooms/:roomId
 * Permanently deletes a room and all its messages, keys, and bans.
 * CASCADE on the DB schema handles child rows automatically.
 */
router.delete("/rooms/:roomId", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { roomId } = req.params as { roomId: string };

  const [room] = await db
    .select({ id: roomsTable.id, name: roomsTable.name })
    .from(roomsTable)
    .where(eq(roomsTable.id, roomId));

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  await db.delete(roomsTable).where(eq(roomsTable.id, roomId));

  res.json({ ok: true, deleted: { id: room.id, name: room.name } });
});

/**
 * PATCH /api/admin/rooms/:roomId/deactivate
 * Soft-deactivates a room (hides it from listings) without deleting data.
 */
router.patch("/rooms/:roomId/deactivate", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { roomId } = req.params as { roomId: string };

  const [room] = await db
    .select({ id: roomsTable.id })
    .from(roomsTable)
    .where(eq(roomsTable.id, roomId));

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  await db
    .update(roomsTable)
    .set({ isActive: false })
    .where(eq(roomsTable.id, roomId));
  setRoomActiveForModeration(roomId, false);

  res.json({ ok: true });
});

/**
 * PATCH /api/admin/rooms/:roomId/reactivate
 * Re-activates a previously deactivated room.
 */
router.patch("/rooms/:roomId/reactivate", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { roomId } = req.params as { roomId: string };

  await db
    .update(roomsTable)
    .set({ isActive: true, lastAccessedAt: new Date() })
    .where(eq(roomsTable.id, roomId));
  setRoomActiveForModeration(roomId, true);

  res.json({ ok: true });
});

export default router;
