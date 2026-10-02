import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { roomsTable } from "./rooms";

/**
 * Per-recipient encrypted copies of a room's symmetric key, so each member
 * can decrypt room content with their own key pair (E2EE fan-out).
 */
export const roomKeyEnvelopesTable = pgTable(
  "room_key_envelopes",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    senderPublicKey: text("sender_public_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    roomUserPk: primaryKey({
      name: "room_key_envelopes_room_user_pk",
      columns: [table.roomId, table.userId],
    }),
  }),
);

export type RoomKeyEnvelope = typeof roomKeyEnvelopesTable.$inferSelect;
