import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { roomsTable } from "./rooms";

/**
 * Encrypted collaborative sandbox/code-share state for a room. One row per
 * room; overwritten in place as members edit the shared sandbox.
 */
export const sandboxStatesTable = pgTable("sandbox_states", {
  roomId: text("room_id")
    .primaryKey()
    .references(() => roomsTable.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type SandboxState = typeof sandboxStatesTable.$inferSelect;
