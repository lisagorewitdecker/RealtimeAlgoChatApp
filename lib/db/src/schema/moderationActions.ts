import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Append-only audit trail of admin ban/restore actions. Usernames and email
 * are snapshotted at the time of the action so history stays readable even
 * if an account is later renamed or deleted.
 */
export const moderationActionsTable = pgTable("moderation_actions", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorUsername: text("actor_username").notNull(),
  targetUserId: text("target_user_id").notNull(),
  targetUsername: text("target_username").notNull(),
  targetEmail: text("target_email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ModerationActionRow = typeof moderationActionsTable.$inferSelect;
