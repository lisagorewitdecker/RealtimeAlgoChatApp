import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { roomsTable } from "./rooms";

export const messagesTable = pgTable("messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => roomsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  // E2EE fields — store ciphertext/nonce only; no plaintext ever stored
  ciphertext: text("ciphertext"), // base64, null for system messages
  nonce: text("nonce"), // base64, null for system messages
  type: text("type", { enum: ["text", "system"] }).notNull(),
  // For system messages we store a plain description (no PII content)
  systemContent: text("system_content"),
  timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export type Message = typeof messagesTable.$inferSelect;
