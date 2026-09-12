import {
  db,
  messagesTable,
  roomKeyEnvelopesTable,
  sandboxStatesTable,
  userProfilesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export async function getPublicKey(userId: string): Promise<string | null> {
  const [profile] = await db
    .select({ publicKey: userProfilesTable.publicKey })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, userId))
    .limit(1);
  return profile?.publicKey ?? null;
}

/**
 * The account's registered device key together with the key the most recent
 * replacement displaced. The previous key is what still lets a signed-in
 * session that kept using it hand its room keys to the new registration.
 */
export interface PublicKeyRecord {
  publicKey: string | null;
  previousPublicKey: string | null;
  registrationVersion: number | null;
}

export async function getPublicKeyRecord(userId: string): Promise<PublicKeyRecord> {
  const [profile] = await db
    .select({
      publicKey: userProfilesTable.publicKey,
      previousPublicKey: userProfilesTable.previousPublicKey,
      registrationVersion: userProfilesTable.publicKeyRegistrationVersion,
    })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, userId))
    .limit(1);
  return {
    publicKey: profile?.publicKey ?? null,
    previousPublicKey: profile?.previousPublicKey ?? null,
    registrationVersion: profile?.registrationVersion ?? null,
  };
}

export type PublicKeyRegistration =
  | { outcome: "registered"; publicKey: string }
  | { outcome: "conflict"; registeredPublicKey: string | null }
  | {
      outcome: "stale" | "future";
      registeredPublicKey: string | null;
      registrationVersion: number | null;
    };

/**
 * Registers a device public key with compare-and-set semantics so that key
 * writes are never last-write-wins across an account's devices and sessions.
 *
 * The write applies only when the key the account holds right now equals
 * `previousPublicKey` (`null` meaning no key yet) or already equals
 * `publicKey` (an idempotent retry). Anything else is a conflict that leaves
 * the stored key untouched and reports what the server holds, so a delayed
 * registration from an older device or session cannot undo a newer reset.
 * Versioned writes must advance the account revision by exactly one (or repeat
 * the same key at its current revision). This bounds client input: a future
 * client clock or fabricated revision cannot permanently lock the account.
 * Each branch is a single guarded statement, so concurrent writers serialize
 * on the row and exactly one of two competing takeovers wins.
 *
 * A replacement also records the key it displaced as `previousPublicKey`
 * (an idempotent retry keeps the earlier record), so the server can later
 * authenticate a room-key handover from a session still holding that key.
 */
export async function registerPublicKey(
  userId: string,
  publicKey: string,
  previousPublicKey: string | null,
  registrationVersion?: number | null,
): Promise<PublicKeyRegistration> {
  const updatedAt = new Date();
  const hasVersion =
    typeof registrationVersion === "number" &&
    Number.isSafeInteger(registrationVersion) &&
    registrationVersion >= 0;
  const versionCondition = hasVersion
    ? or(
        and(
          isNull(userProfilesTable.publicKeyRegistrationVersion),
          sql`${registrationVersion} = 1`,
        ),
        sql`${userProfilesTable.publicKeyRegistrationVersion} = ${registrationVersion} - 1`,
        and(
          eq(
            userProfilesTable.publicKeyRegistrationVersion,
            registrationVersion,
          ),
          eq(userProfilesTable.publicKey, publicKey),
        ),
      )
    : undefined;
  // An INSERT can bypass the ON CONFLICT guard when the account has no row.
  // Reject every non-initial revision before issuing any write so a client
  // cannot seed an arbitrary future revision into an empty account.
  if (hasVersion && registrationVersion !== 1 && previousPublicKey === null) {
    const current = await getPublicKeyRecord(userId);
    if (current.publicKey === null && current.registrationVersion === null) {
      return {
        outcome: "future",
        registeredPublicKey: null,
        registrationVersion: null,
      };
    }
  }
  const applied =
    previousPublicKey === null
      ? await db
          .insert(userProfilesTable)
          .values({
            userId,
            username: userId,
            publicKey,
            updatedAt,
            ...(hasVersion
              ? { publicKeyRegistrationVersion: registrationVersion }
              : {}),
          })
          .onConflictDoUpdate({
            target: userProfilesTable.userId,
            set: {
              publicKey,
              updatedAt,
              ...(hasVersion
                ? { publicKeyRegistrationVersion: registrationVersion }
                : {}),
            },
            setWhere: and(
              or(
                isNull(userProfilesTable.publicKey),
                eq(userProfilesTable.publicKey, publicKey),
              ),
              ...(versionCondition ? [versionCondition] : []),
            ),
          })
          .returning({
            publicKey: userProfilesTable.publicKey,
            registrationVersion: userProfilesTable.publicKeyRegistrationVersion,
          })
      : await db
          .update(userProfilesTable)
          .set({
            publicKey,
            updatedAt,
            ...(hasVersion
              ? { publicKeyRegistrationVersion: registrationVersion }
              : {}),
            // SET expressions read the row's old values: a real replacement
            // records the displaced key, an idempotent retry keeps the record.
            previousPublicKey: sql`CASE WHEN ${userProfilesTable.publicKey} = ${publicKey} THEN ${userProfilesTable.previousPublicKey} ELSE ${userProfilesTable.publicKey} END`,
          })
          .where(
            and(
              eq(userProfilesTable.userId, userId),
              inArray(userProfilesTable.publicKey, [previousPublicKey, publicKey]),
              ...(versionCondition ? [versionCondition] : []),
            ),
          )
          .returning({
            publicKey: userProfilesTable.publicKey,
            registrationVersion: userProfilesTable.publicKeyRegistrationVersion,
          });

  if (applied.length > 0) return { outcome: "registered", publicKey };
  const current = await getPublicKeyRecord(userId);
  if (hasVersion) {
    const currentVersion = current.registrationVersion ?? 0;
    const expectedVersion = currentVersion + 1;
    if (registrationVersion < expectedVersion) {
      return {
        outcome: "stale",
        registeredPublicKey: current.publicKey,
        registrationVersion: current.registrationVersion,
      };
    }
    if (registrationVersion > expectedVersion) {
      return {
        outcome: "future",
        registeredPublicKey: current.publicKey,
        registrationVersion: current.registrationVersion,
      };
    }
  }
  return { outcome: "conflict", registeredPublicKey: current.publicKey };
}

export async function getRoomEnvelope(roomId: string, userId: string) {
  const [envelope] = await db
    .select({
      ciphertext: roomKeyEnvelopesTable.ciphertext,
      nonce: roomKeyEnvelopesTable.nonce,
      senderPublicKey: roomKeyEnvelopesTable.senderPublicKey,
    })
    .from(roomKeyEnvelopesTable)
    .where(
      and(
        eq(roomKeyEnvelopesTable.roomId, roomId),
        eq(roomKeyEnvelopesTable.userId, userId),
      ),
    )
    .limit(1);
  return envelope ?? null;
}

export async function saveRoomEnvelope({
  roomId,
  userId,
  ciphertext,
  nonce,
  senderPublicKey,
}: {
  roomId: string;
  userId: string;
  ciphertext: string;
  nonce: string;
  senderPublicKey: string;
}): Promise<void> {
  await db
    .insert(roomKeyEnvelopesTable)
    .values({ roomId, userId, ciphertext, nonce, senderPublicKey })
    .onConflictDoUpdate({
      target: [roomKeyEnvelopesTable.roomId, roomKeyEnvelopesTable.userId],
      set: { ciphertext, nonce, senderPublicKey, createdAt: new Date() },
    });
}

export async function loadEncryptedMessages(roomId: string) {
  return db
    .select({
      id: messagesTable.id,
      ciphertext: messagesTable.ciphertext,
      nonce: messagesTable.nonce,
      userId: messagesTable.userId,
      username: messagesTable.username,
      timestamp: messagesTable.timestampMs,
      type: messagesTable.type,
      systemContent: messagesTable.systemContent,
    })
    .from(messagesTable)
    .where(and(eq(messagesTable.roomId, roomId), isNull(messagesTable.deletedAt)))
    .orderBy(desc(messagesTable.timestampMs))
    .limit(80)
    .then((rows) => rows.reverse());
}

export async function saveEncryptedMessage({
  id,
  roomId,
  userId,
  username,
  ciphertext,
  nonce,
  timestamp,
}: {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  ciphertext: string;
  nonce: string;
  timestamp: number;
}): Promise<void> {
  await db.insert(messagesTable).values({
    id,
    roomId,
    userId,
    username,
    ciphertext,
    nonce,
    type: "text",
    timestampMs: timestamp,
  });
}

export async function loadEncryptedSandboxState(
  roomId: string,
): Promise<{
  ciphertext: string;
  nonce: string;
} | null> {
  const [state] = await db
    .select({
      ciphertext: sandboxStatesTable.ciphertext,
      nonce: sandboxStatesTable.nonce,
    })
    .from(sandboxStatesTable)
    .where(eq(sandboxStatesTable.roomId, roomId))
    .limit(1);
  return state ?? null;
}

export async function saveEncryptedSandboxState({
  roomId,
  ciphertext,
  nonce,
  updatedBy,
}: {
  roomId: string;
  ciphertext: string;
  nonce: string;
  updatedBy: string;
}): Promise<void> {
  await db
    .insert(sandboxStatesTable)
    .values({ roomId, ciphertext, nonce, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sandboxStatesTable.roomId,
      set: { ciphertext, nonce, updatedBy, updatedAt: new Date() },
    });
}