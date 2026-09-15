import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Persists the short window during which a kicked user cannot rejoin a room.
 * A single row per room/user is refreshed when the user is kicked again.
 */
export const roomKickCooldownsTable = pgTable(
  "room_kick_cooldowns",
  {
    roomId: text("room_id").notNull(),
    userId: text("user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => ({
    roomUserPk: primaryKey({ columns: [table.roomId, table.userId] }),
  }),
);

export type RoomKickCooldown = typeof roomKickCooldownsTable.$inferSelect;