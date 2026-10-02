import { randomUUID } from "node:crypto";
import { db, moderationActionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const actorUserId = `moderation-shape-test-${randomUUID()}`;

const baseRecord = {
  actorUserId,
  actorUsername: "Audit Test Admin",
};

async function expectConstraintViolation(
  values: typeof moderationActionsTable.$inferInsert,
): Promise<void> {
  await expect(db.insert(moderationActionsTable).values(values)).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: "23514",
      constraint: "moderation_actions_valid_shape_v3",
    }),
  });
}

beforeAll(() => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required for moderation audit shape tests.");
  }
});

afterAll(async () => {
  await db
    .delete(moderationActionsTable)
    .where(eq(moderationActionsTable.actorUserId, actorUserId));
});

describe("moderation action database shape constraint", () => {
  it.each(["ban", "restore"] as const)(
    "accepts a complete %s account action",
    async (action) => {
      await expect(
        db.insert(moderationActionsTable).values({
          ...baseRecord,
          action,
          targetUserId: "target-user",
          targetUsername: "Target User",
          targetEmail: action === "ban" ? "target@example.com" : null,
        }),
      ).resolves.toBeDefined();
    },
  );

  it("accepts a complete message deletion action", async () => {
    await expect(
      db.insert(moderationActionsTable).values({
        ...baseRecord,
        action: "message_delete",
        roomId: "room-1",
        messageId: "message-1",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects unsupported actions", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "mute",
      targetUserId: "target-user",
      targetUsername: "Target User",
      targetEmail: "target@example.com",
    });
  });

  it("rejects incomplete account actions", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "ban",
      targetUserId: "target-user",
      targetEmail: "target@example.com",
    });
  });

  it("rejects account actions with blank target identifiers", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "restore",
      targetUserId: " ",
      targetUsername: "Target User",
    });
  });

  it("rejects incomplete message deletion actions", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "message_delete",
      roomId: "room-1",
    });
  });

  it("rejects message deletions with blank message identifiers", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "message_delete",
      roomId: "room-1",
      messageId: " ",
    });
  });

  it("rejects account actions mixed with message metadata", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "restore",
      targetUserId: "target-user",
      targetUsername: "Target User",
      targetEmail: "target@example.com",
      roomId: "room-1",
      messageId: "message-1",
    });
  });

  it("rejects message deletions mixed with account metadata", async () => {
    await expectConstraintViolation({
      ...baseRecord,
      action: "message_delete",
      targetUserId: "target-user",
      targetUsername: "Target User",
      targetEmail: "target@example.com",
      roomId: "room-1",
      messageId: "message-1",
    });
  });
});