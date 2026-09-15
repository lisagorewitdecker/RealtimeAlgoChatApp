import { createHmac, timingSafeEqual } from "node:crypto";

export type RoomAccessPurpose = "call" | "sandbox";

interface RoomAccessPayload {
  roomId: string;
  userId: string;
  username: string;
  avatarEmoji: string;
  purpose: RoomAccessPurpose;
  expiresAt: number;
}

const CAPABILITY_TTL_MS = 2 * 60 * 1000;

function signingKey(): string {
  const key = process.env["SESSION_SECRET"];
  if (!key) {
    throw new Error("SESSION_SECRET is required to issue room access capabilities.");
  }
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function createRoomAccessCapability(
  payload: Omit<RoomAccessPayload, "expiresAt">,
): string {
  const encoded = Buffer.from(
    JSON.stringify({ ...payload, expiresAt: Date.now() + CAPABILITY_TTL_MS }),
  ).toString("base64url");

  return `${encoded}.${sign(encoded)}`;
}

export function verifyRoomAccessCapability(
  token: string,
): RoomAccessPayload | null {
  const [encoded, signature, ...remainder] = token.split(".");
  if (!encoded || !signature || remainder.length > 0) return null;

  const expectedSignature = sign(encoded);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<RoomAccessPayload>;

    if (
      !isRoomAccessPurpose(payload.purpose) ||
      !isNonEmptyString(payload.roomId, 64) ||
      !isNonEmptyString(payload.userId, 128) ||
      !isNonEmptyString(payload.username, 30) ||
      !isNonEmptyString(payload.avatarEmoji, 16) ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload as RoomAccessPayload;
  } catch {
    return null;
  }
}

function isRoomAccessPurpose(value: unknown): value is RoomAccessPurpose {
  return value === "call" || value === "sandbox";
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}