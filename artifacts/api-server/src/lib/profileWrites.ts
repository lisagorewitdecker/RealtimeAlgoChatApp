import { db, userProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface ProfileWrite {
  username?: string;
  avatar?: string | null;
  publicKey?: string | null;
}

export async function upsertProfile(userId: string, write: ProfileWrite) {
  const updatedAt = new Date();
  const updates: ProfileWrite & { updatedAt: Date } = { updatedAt };

  if (write.username !== undefined) updates.username = write.username;
  if (write.avatar !== undefined) updates.avatar = write.avatar;
  if (write.publicKey !== undefined) updates.publicKey = write.publicKey;

  await db
    .insert(userProfilesTable)
    .values({
      userId,
      username: write.username ?? userId,
      avatar: write.avatar ?? null,
      publicKey: write.publicKey ?? null,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: userProfilesTable.userId,
      set: updates,
    });

  const [profile] = await db
    .select()
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, userId));

  return profile;
}