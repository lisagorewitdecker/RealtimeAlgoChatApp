import { db, moderationActionsTable } from "@workspace/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { logger } from "./logger";
import { getAccountSnapshot } from "./accountProfile";

export type ModerationActionKind = "ban" | "restore";

export interface ModerationHistoryEntry {
  id: number;
  action: ModerationActionKind;
  actorUserId: string;
  actorUsername: string;
  targetUserId: string;
  targetUsername: string;
  targetEmail: string | null;
  createdAt: string;
}

export interface ModerationHistoryQuery {
  /** Only return actions older than this row id (for "load more" paging). */
  cursor?: number;
  /** Page size, capped at MAX_MODERATION_HISTORY_PAGE_SIZE. */
  limit?: number;
  /** Restrict to actions taken on this account. */
  targetUserId?: string;
  /** Restrict to actions taken by this administrator. */
  actorUserId?: string;
}

export interface ModerationHistoryPage {
  entries: ModerationHistoryEntry[];
  /** Pass as `cursor` to fetch the next page, or null if there are no more. */
  nextCursor: number | null;
}

const DEFAULT_MODERATION_HISTORY_PAGE_SIZE = 50;
const MAX_MODERATION_HISTORY_PAGE_SIZE = 50;

/**
 * Records who performed a ban/restore action, on which account, and when.
 * Display names and email are snapshotted at the time of the action so the
 * trail stays readable even if the account is later renamed or deleted.
 *
 * The ban/restore itself has already succeeded by the time this is called,
 * so a failure here is logged but never surfaced as a failed request --
 * otherwise an admin could be misled into retrying an action that already
 * took effect.
 */
export async function recordModerationAction(
  action: ModerationActionKind,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  try {
    const [actor, target] = await Promise.all([
      getAccountSnapshot(actorUserId),
      getAccountSnapshot(targetUserId),
    ]);

    await db.insert(moderationActionsTable).values({
      action,
      actorUserId,
      actorUsername: actor.username,
      targetUserId,
      targetUsername: target.username,
      targetEmail: target.email,
    });
  } catch (error) {
    logger.error({ err: error, action, actorUserId, targetUserId }, "failed to record moderation action");
  }
}

/**
 * Lists ban/restore history, newest first, with cursor-based paging and
 * optional filtering by target account or acting administrator.
 *
 * Ordering (and the paging cursor) is based on `id` rather than
 * `createdAt`: `id` is a strictly increasing serial column, so it gives an
 * unambiguous order and cursor even when two actions share a timestamp.
 */
export async function listModerationActions(
  query: ModerationHistoryQuery = {},
): Promise<ModerationHistoryPage> {
  const limit = Math.min(
    Math.max(query.limit ?? DEFAULT_MODERATION_HISTORY_PAGE_SIZE, 1),
    MAX_MODERATION_HISTORY_PAGE_SIZE,
  );

  const conditions = [];
  if (query.cursor !== undefined) {
    conditions.push(lt(moderationActionsTable.id, query.cursor));
  }
  if (query.targetUserId) {
    conditions.push(eq(moderationActionsTable.targetUserId, query.targetUserId));
  }
  if (query.actorUserId) {
    conditions.push(eq(moderationActionsTable.actorUserId, query.actorUserId));
  }

  // Fetch one extra row to know whether another page exists without a
  // separate count query.
  const rows = await db
    .select()
    .from(moderationActionsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(moderationActionsTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    entries: page.map((row) => ({
      id: row.id,
      action: row.action as ModerationActionKind,
      actorUserId: row.actorUserId,
      actorUsername: row.actorUsername,
      targetUserId: row.targetUserId,
      targetUsername: row.targetUsername,
      targetEmail: row.targetEmail,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
