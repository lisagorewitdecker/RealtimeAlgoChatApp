import { randomUUID } from "node:crypto";
import { db, userProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getPublicKey, getPublicKeyRecord, registerPublicKey } from "./e2eePersistence";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const createdUserIds: string[] = [];

function newUserId() {
  const userId = `e2ee-registration-test-${randomUUID()}`;
  createdUserIds.push(userId);
  return userId;
}

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(userProfilesTable).where(eq(userProfilesTable.userId, userId));
  }
});

describe("registerPublicKey compare-and-set semantics", () => {
  it("registers a first key, accepts idempotent re-sends, and refuses a silent replacement", async () => {
    const userId = newUserId();

    await expect(registerPublicKey(userId, key(1), null)).resolves.toEqual({
      outcome: "registered",
      publicKey: key(1),
    });
    await expect(registerPublicKey(userId, key(1), null)).resolves.toEqual({
      outcome: "registered",
      publicKey: key(1),
    });
    // A different key without the current one named is a conflict.
    await expect(registerPublicKey(userId, key(2), null)).resolves.toEqual({
      outcome: "conflict",
      registeredPublicKey: key(1),
    });
    await expect(getPublicKey(userId)).resolves.toBe(key(1));
  });

  it("replaces the key only when the caller names the key it replaces", async () => {
    const userId = newUserId();
    await registerPublicKey(userId, key(1), null);

    await expect(registerPublicKey(userId, key(2), key(9))).resolves.toEqual({
      outcome: "conflict",
      registeredPublicKey: key(1),
    });
    await expect(registerPublicKey(userId, key(2), key(1))).resolves.toEqual({
      outcome: "registered",
      publicKey: key(2),
    });
    // Retrying the same takeover after it already applied is harmless.
    await expect(registerPublicKey(userId, key(2), key(1))).resolves.toEqual({
      outcome: "registered",
      publicKey: key(2),
    });
    await expect(getPublicKey(userId)).resolves.toBe(key(2));
  });

  it("keeps a reset key when delayed writes from an older device or session land afterwards", async () => {
    const userId = newUserId();
    const oldKey = key(1);
    const resetKey = key(2);
    await registerPublicKey(userId, oldKey, null);
    await registerPublicKey(userId, resetKey, oldKey);

    // The old session's periodic re-registration and a takeover it started
    // before the reset both name stale state and must lose.
    await expect(registerPublicKey(userId, oldKey, null)).resolves.toEqual({
      outcome: "conflict",
      registeredPublicKey: resetKey,
    });
    await expect(registerPublicKey(userId, key(3), oldKey)).resolves.toEqual({
      outcome: "conflict",
      registeredPublicKey: resetKey,
    });
    await expect(getPublicKey(userId)).resolves.toBe(resetKey);
  });

  it("lets exactly one of two concurrent takeovers win", async () => {
    const userId = newUserId();
    await registerPublicKey(userId, key(1), null);

    const results = await Promise.all([
      registerPublicKey(userId, key(2), key(1)),
      registerPublicKey(userId, key(3), key(1)),
    ]);

    const winners = results.filter((result) => result.outcome === "registered");
    const losers = results.filter((result) => result.outcome === "conflict");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const stored = await getPublicKey(userId);
    expect(stored).toBe(winners[0]!.outcome === "registered" ? winners[0]!.publicKey : null);
    expect(losers[0]).toEqual({ outcome: "conflict", registeredPublicKey: stored });
  });

  it("records the displaced key so a superseded session can still hand over room keys", async () => {
    const userId = newUserId();
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: null,
      previousPublicKey: null,
    });

    await registerPublicKey(userId, key(1), null);
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(1),
      previousPublicKey: null,
    });

    // A takeover records the key it displaced; retrying it keeps that record
    // instead of pretending the new key displaced itself.
    await registerPublicKey(userId, key(2), key(1));
    await registerPublicKey(userId, key(2), key(1));
    await registerPublicKey(userId, key(2), null);
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(2),
      previousPublicKey: key(1),
    });

    // Refused writes leave the record untouched.
    await registerPublicKey(userId, key(3), key(1));
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(2),
      previousPublicKey: key(1),
    });

    // The next takeover rotates the record: only the most recently displaced
    // key may still hand over.
    await registerPublicKey(userId, key(3), key(2));
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(3),
      previousPublicKey: key(2),
    });
  });

  it("reports a conflict with no key when a takeover names a key the account never had", async () => {
    const userId = newUserId();

    await expect(registerPublicKey(userId, key(2), key(1))).resolves.toEqual({
      outcome: "conflict",
      registeredPublicKey: null,
    });
    await expect(getPublicKey(userId)).resolves.toBeNull();
  });
});
