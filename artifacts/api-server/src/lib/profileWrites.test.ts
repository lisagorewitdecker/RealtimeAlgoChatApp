import { randomUUID } from "node:crypto";
import { db, userProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { upsertProfile } from "./profileWrites";

test("concurrent partial profile writes preserve every supplied field", async () => {
  const userId = `profile-write-test-${randomUUID()}`;
  const publicKey = Buffer.alloc(32, 7).toString("base64");

  try {
    await upsertProfile(userId, {
      username: "Before",
      avatar: null,
      publicKey: null,
    });

    await Promise.all([
      upsertProfile(userId, { username: "After" }),
      upsertProfile(userId, { avatar: "🚀" }),
      upsertProfile(userId, { publicKey }),
    ]);

    const [profile] = await db
      .select()
      .from(userProfilesTable)
      .where(eq(userProfilesTable.userId, userId));

    expect(profile?.username).toBe("After");
    expect(profile?.avatar).toBe("🚀");
    expect(profile?.publicKey).toBe(publicKey);
  } finally {
    await db
      .delete(userProfilesTable)
      .where(eq(userProfilesTable.userId, userId));
  }
});