import { clerkClient } from "@clerk/express";

const ACCESS_METADATA_KEY = "devStudioAccess";
const pendingAccessChecks = new Map<string, Promise<AccountAccess>>();

export type AccountAccess =
  | { allowed: true }
  | { allowed: false; reason: "banned" | "unverified" };

function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBanned(privateMetadata: Record<string, unknown>): boolean {
  return getRecord(privateMetadata[ACCESS_METADATA_KEY])?.["banned"] === true;
}

export function isAccountBanned(privateMetadata: Record<string, unknown>): boolean {
  return isBanned(privateMetadata);
}

function hasVerifiedPrimaryEmail(user: {
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    verification: { status: string | null } | null;
  }>;
}): boolean {
  const primaryEmail = user.emailAddresses.find(
    (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
  );
  return primaryEmail?.verification?.status === "verified";
}

function retryDelayMs(error: unknown, attempt: number): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; retryAfter?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : null;
  if (status !== 429 && (status === null || status < 500 || status >= 600)) {
    return null;
  }
  const retryAfter =
    typeof candidate.retryAfter === "number" && candidate.retryAfter >= 0
      ? candidate.retryAfter * 1_000
      : 0;
  return Math.max(retryAfter, 250 * 2 ** attempt);
}

async function loadAccountAccess(userId: string): Promise<AccountAccess> {
  let user: Awaited<ReturnType<typeof clerkClient.users.getUser>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      user = await clerkClient.users.getUser(userId);
      break;
    } catch (error) {
      const delayMs = retryDelayMs(error, attempt);
      if (delayMs === null || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (isBanned(user.privateMetadata)) return { allowed: false, reason: "banned" };
  return hasVerifiedPrimaryEmail(user)
    ? { allowed: true }
    : { allowed: false, reason: "unverified" };
}

export async function getAccountAccess(userId: string): Promise<AccountAccess> {
  const existing = pendingAccessChecks.get(userId);
  if (existing) return existing;

  const pending = loadAccountAccess(userId);
  pendingAccessChecks.set(userId, pending);
  try {
    return await pending;
  } finally {
    if (pendingAccessChecks.get(userId) === pending) {
      pendingAccessChecks.delete(userId);
    }
  }
}

export async function setAccountBan(
  userId: string,
  banned: boolean,
): Promise<void> {
  const user = await clerkClient.users.getUser(userId);
  const existingAccess = getRecord(user.privateMetadata[ACCESS_METADATA_KEY]) ?? {};
  await clerkClient.users.updateUserMetadata(userId, {
    privateMetadata: {
      ...user.privateMetadata,
      [ACCESS_METADATA_KEY]: {
        ...existingAccess,
        banned,
        ...(banned ? { bannedAt: new Date().toISOString() } : { bannedAt: null }),
      },
    },
  });
}

export function isConfiguredAdmin(userId: string): boolean {
  return (process.env["ADMIN_USER_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}