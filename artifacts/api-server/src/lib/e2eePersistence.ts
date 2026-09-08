import {
  db,
  messagesTable,
  roomKeyEnvelopesTable,
  sandboxStatesTable,
  userProfilesTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

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

export async function savePublicKey(
  userId: string,
  publicKey: string,
): Promise<void> {
  await db
    .insert(userProfilesTable)
    .values({ userId, username: userId, publicKey })
    .onConflictDoUpdate({
      target: userProfilesTable.userId,
      set: { publicKey, updatedAt: new Date() },
    });
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