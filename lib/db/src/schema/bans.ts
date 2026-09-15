import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { roomsTable } from "./rooms";

export const roomBansTable = pgTable("room_bans", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => roomsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  bannedBy: text("banned_by").notNull(),
  isPermanent: boolean("is_permanent").default(false).notNull(),
  expiresAt: timestamp("expires_at"),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RoomBan = typeof roomBansTable.$inferSelect;
