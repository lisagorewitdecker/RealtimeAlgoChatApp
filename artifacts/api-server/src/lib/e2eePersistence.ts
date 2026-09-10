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
}

export async function getPublicKeyRecord(userId: string): Promise<PublicKeyRecord> {
  const [profile] = await db
    .select({
      publicKey: userProfilesTable.publicKey,
      previousPublicKey: userProfilesTable.previousPublicKey,
    })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, userId))
    .limit(1);
  return {
    publicKey: profile?.publicKey ?? null,
    previousPublicKey: profile?.previousPublicKey ?? null,
  };
}

export type PublicKeyRegistration =
  | { outcome: "registered"; publicKey: string }
  | { outcome: "conflict"; registeredPublicKey: string | null };

/**
 * Registers a device public key with compare-and-set semantics so that key
 * writes are never last-write-wins across an account's devices and sessions.
 *
 * The write applies only when the key the account holds right now equals
 * `previousPublicKey` (`null` meaning no key yet) or already equals
 * `publicKey` (an idempotent retry). Anything else is a conflict that leaves
 * the stored key untouched and reports what the server holds, so a delayed
 * registration from an older device or session cannot undo a newer reset.
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
): Promise<PublicKeyRegistration> {
  const updatedAt = new Date();
  const applied =
    previousPublicKey === null
      ? await db
          .insert(userProfilesTable)
          .values({ userId, username: userId, publicKey, updatedAt })
          .onConflictDoUpdate({
            target: userProfilesTable.userId,
            set: { publicKey, updatedAt },
            setWhere: or(
              isNull(userProfilesTable.publicKey),
              eq(userProfilesTable.publicKey, publicKey),
            ),
          })
          .returning({ publicKey: userProfilesTable.publicKey })
      : await db
          .update(userProfilesTable)
          .set({
            publicKey,
            updatedAt,
            // SET expressions read the row's old values: a real replacement
            // records the displaced key, an idempotent retry keeps the record.
            previousPublicKey: sql`CASE WHEN ${userProfilesTable.publicKey} = ${publicKey} THEN ${userProfilesTable.previousPublicKey} ELSE ${userProfilesTable.publicKey} END`,
          })
          .where(
            and(
              eq(userProfilesTable.userId, userId),
              inArray(userProfilesTable.publicKey, [previousPublicKey, publicKey]),
            ),
          )
          .returning({ publicKey: userProfilesTable.publicKey });

  if (applied.length > 0) return { outcome: "registered", publicKey };
  return { outcome: "conflict", registeredPublicKey: await getPublicKey(userId) };
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