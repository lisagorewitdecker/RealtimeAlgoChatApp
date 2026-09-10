import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const userProfilesTable = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  avatar: text("avatar"),
  publicKey: text("public_key"),
  // The key a compare-and-set replacement displaced. A still-signed-in
  // session of the account may hand its retained room keys to the new key
  // while authenticating as this key; the next replacement rotates it.
  previousPublicKey: text("previous_public_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserProfile = typeof userProfilesTable.$inferSelect;
