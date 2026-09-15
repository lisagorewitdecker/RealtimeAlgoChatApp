import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const userProfilesTable = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  avatar: text("avatar"),
  publicKey: text("public_key"),
  // The key a compare-and-set replacement displaced. A still-signed-in
  // session of the account may hand its retained room keys to the new key
  // while authenticating as this key; the next replacement rotates it.
  previousPublicKey: text("previous_public_key"),
  // Optional for compatibility with registrations from older clients. New
  // clients use this persisted sequence to prevent delayed writes from
  // replacing a newer device identity.
  publicKeyRegistrationVersion: bigint("public_key_registration_version", {
    mode: "number",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserProfile = typeof userProfilesTable.$inferSelect;
