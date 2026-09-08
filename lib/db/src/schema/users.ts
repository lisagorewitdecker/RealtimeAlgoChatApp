import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const userProfilesTable = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  avatar: text("avatar"),
  publicKey: text("public_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserProfile = typeof userProfilesTable.$inferSelect;
