import { clerkClient } from "@clerk/express";
import {
  AccountAccessDeadlineError,
  AccountAccessUnavailableError,
} from "./accountAccessUnavailable.js";
import { clerkErrorStatus, clerkRetryDelayMs } from "./clerkRetry.js";

const ACCESS_METADATA_KEY = "devStudioAccess";
const pendingAccessChecks = new Map<string, Promise<AccountAccess>>();

/**
 * Retry policy for one account-access lookup (a single `getAccountAccess`
 * call, which one HTTP request or one socket handshake waits on).
 *
 * A lookup makes at most `ACCOUNT_ACCESS_MAX_ATTEMPTS` Clerk requests. Between
 * attempts it waits `clerkRetryDelayMs`: Clerk's own `retryAfter` guidance or
 * an exponential fallback from `ACCOUNT_ACCESS_RETRY_BASE_DELAY_MS`, each wait
 * capped at `MAX_CLERK_RETRY_DELAY_MS`.
 *
 * `ACCOUNT_ACCESS_RETRY_BUDGET_MS` is a hard wall-clock deadline for the whole
 * lookup, requests included. Before sleeping, the lookup checks that the next
 * wait still ends before the deadline; if it would not, it gives up at once
 * with an `AccountAccessUnavailableError` carrying that wait as the retry
 * hint. Every Clerk request is raced against the time left, so a request that
 * hangs also fails at the deadline (with `AccountAccessDeadlineError` as the
 * cause) instead of holding the caller. Without this, three capped waits
 * could hold a request for ~90 s while Clerk throttles -- longer than reverse
 * proxies and Socket.IO's own 45 s connect timeout allow, so the caller saw a
 * timeout instead of an answer. 15 s keeps the attempt count and delays
 * unchanged for the usual short hints (guidance up to 5 s still gets every
 * attempt) while the answer, including the hint, reaches the client well
 * before those deadlines.
 */
export const ACCOUNT_ACCESS_MAX_ATTEMPTS = 4;
export const ACCOUNT_ACCESS_RETRY_BUDGET_MS = 15_000;
const ACCOUNT_ACCESS_RETRY_BASE_DELAY_MS = 250;

type ClerkUser = Awaited<ReturnType<typeof clerkClient.users.getUser>>;

/**
 * Fetches the Clerk user, rejecting with `AccountAccessDeadlineError` once
 * `deadline` passes. The Clerk SDK offers no abort signal, so a request that
 * loses the race keeps running in the background; whatever it eventually
 * returns is ignored, and the lookup that was waiting on it has already
 * answered its caller.
 */
async function getUserBeforeDeadline(
  userId: string,
  deadline: number,
): Promise<ClerkUser> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new AccountAccessDeadlineError(ACCOUNT_ACCESS_RETRY_BUDGET_MS);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AccountAccessDeadlineError(ACCOUNT_ACCESS_RETRY_BUDGET_MS));
    }, remainingMs);
  });
  try {
    return await Promise.race([clerkClient.users.getUser(userId), expired]);
  } finally {
    clearTimeout(timer);
  }
}

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

function isRetryableClerkError(error: unknown): boolean {
  const status = clerkErrorStatus(error);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

async function loadAccountAccess(userId: string): Promise<AccountAccess> {
  const deadline = Date.now() + ACCOUNT_ACCESS_RETRY_BUDGET_MS;
  let user: ClerkUser;
  for (let attempt = 0; ; attempt += 1) {
    try {
      user = await getUserBeforeDeadline(userId, deadline);
      break;
    } catch (error) {
      const attempts = attempt + 1;
      const delayMs = clerkRetryDelayMs(
        error,
        attempt,
        ACCOUNT_ACCESS_RETRY_BASE_DELAY_MS,
      );
      if (
        error instanceof AccountAccessDeadlineError ||
        !isRetryableClerkError(error) ||
        attempts >= ACCOUNT_ACCESS_MAX_ATTEMPTS ||
        Date.now() + delayMs > deadline
      ) {
        throw new AccountAccessUnavailableError(error, {
          retryAfterMs: delayMs,
          attempts,
        });
      }
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