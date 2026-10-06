import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const socketRevocationOutboxTable = pgTable("socket_revocation_outbox", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
