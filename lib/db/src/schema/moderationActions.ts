import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Append-only audit trail of moderation actions. Usernames and email are
 * snapshotted where applicable so history stays readable even if an account
 * is later renamed or deleted. Message content is never stored here.
 */
export const moderationActionsTable = pgTable("moderation_actions", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorUsername: text("actor_username").notNull(),
  targetUserId: text("target_user_id"),
  targetUsername: text("target_username"),
  targetEmail: text("target_email"),
  roomId: text("room_id"),
  messageId: text("message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ModerationActionRow = typeof moderationActionsTable.$inferSelect;
