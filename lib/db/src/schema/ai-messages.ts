import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { conversationsTable } from "./conversations";

export const aiMessagesTable = pgTable("ai_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type AiMessage = typeof aiMessagesTable.$inferSelect;
