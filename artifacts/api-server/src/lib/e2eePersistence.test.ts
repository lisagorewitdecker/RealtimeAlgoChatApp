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

  it("rejects an older registration version without overwriting the newer key", async () => {
    const userId = newUserId();
    const oldKey = key(1);
    const resetKey = key(2);

    await expect(registerPublicKey(userId, oldKey, null, 1)).resolves.toEqual({
      outcome: "registered",
      publicKey: oldKey,
    });
    await expect(registerPublicKey(userId, resetKey, oldKey, 2)).resolves.toEqual({
      outcome: "registered",
      publicKey: resetKey,
    });

    // A delayed request can still have a valid compare-and-set predecessor,
    // but its version proves that it was prepared before the reset.
    await expect(registerPublicKey(userId, oldKey, oldKey, 1)).resolves.toEqual({
      outcome: "stale",
      registeredPublicKey: resetKey,
      registrationVersion: 2,
    });
    await expect(getPublicKeyRecord(userId)).resolves.toMatchObject({
      publicKey: resetKey,
      registrationVersion: 2,
    });
  });

  it("rejects a future-skewed version without advancing the account revision", async () => {
    const userId = newUserId();
    await registerPublicKey(userId, key(1), null, 1);

    await expect(registerPublicKey(userId, key(2), key(1), 1000)).resolves.toEqual({
      outcome: "future",
      registeredPublicKey: key(1),
      registrationVersion: 1,
    });
    await expect(getPublicKeyRecord(userId)).resolves.toMatchObject({
      publicKey: key(1),
      registrationVersion: 1,
    });
  });

  it.each([0, 2, Number.MAX_SAFE_INTEGER])(
    "does not seed an empty account with version %s",
    async (registrationVersion) => {
      const userId = newUserId();
      const publicKey = key(7);

      await expect(
        registerPublicKey(userId, publicKey, null, registrationVersion),
      ).resolves.toEqual({
        outcome: "future",
        registeredPublicKey: null,
        registrationVersion: null,
      });
      await expect(getPublicKeyRecord(userId)).resolves.toEqual({
        publicKey: null,
        previousPublicKey: null,
        registrationVersion: null,
      });

      await expect(registerPublicKey(userId, publicKey, null, 1)).resolves.toEqual({
        outcome: "registered",
        publicKey,
      });
      await expect(getPublicKeyRecord(userId)).resolves.toMatchObject({
        publicKey,
        registrationVersion: 1,
      });
    },
  );

  it("keeps version ordering optional for older compare-and-set clients", async () => {
    const userId = newUserId();
    await expect(registerPublicKey(userId, key(1), null)).resolves.toEqual({
      outcome: "registered",
      publicKey: key(1),
    });
    await expect(registerPublicKey(userId, key(2), key(1))).resolves.toEqual({
      outcome: "registered",
      publicKey: key(2),
    });
    await expect(getPublicKeyRecord(userId)).resolves.toMatchObject({
      publicKey: key(2),
      registrationVersion: null,
    });
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
      registrationVersion: null,
    });

    await registerPublicKey(userId, key(1), null);
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(1),
      previousPublicKey: null,
      registrationVersion: null,
    });

    // A takeover records the key it displaced; retrying it keeps that record
    // instead of pretending the new key displaced itself.
    await registerPublicKey(userId, key(2), key(1));
    await registerPublicKey(userId, key(2), key(1));
    await registerPublicKey(userId, key(2), null);
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(2),
      previousPublicKey: key(1),
      registrationVersion: null,
    });

    // Refused writes leave the record untouched.
    await registerPublicKey(userId, key(3), key(1));
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(2),
      previousPublicKey: key(1),
      registrationVersion: null,
    });

    // The next takeover rotates the record: only the most recently displaced
    // key may still hand over.
    await registerPublicKey(userId, key(3), key(2));
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: key(3),
      previousPublicKey: key(2),
      registrationVersion: null,
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
