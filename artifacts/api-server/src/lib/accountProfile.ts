import { clerkClient } from "@clerk/express";
import { isAccountBanned } from "./accountAccess";

const DEFAULT_AVATAR_EMOJI = "🧑‍💻";
const DEFAULT_USERNAME = "Member";
const PROFILE_METADATA_KEY = "devStudioProfile";
const MAX_ACCOUNT_SEARCH_RESULTS = 8;
const MIN_ACCOUNT_SEARCH_QUERY_LENGTH = 2;

export interface AccountProfile {
  username: string;
  avatarEmoji: string;
}

export interface AccountSearchResult {
  userId: string;
  username: string;
  avatarEmoji: string;
  email: string | null;
  banned: boolean;
}

export interface AccountSnapshot {
  userId: string;
  username: string;
  email: string | null;
}

export function normalizeProfileUsername(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_USERNAME;
  const username = value.trim().replace(/\s+/g, " ");
  return username.length >= 2 && username.length <= 30
    ? username
    : DEFAULT_USERNAME;
}

export function normalizeProfileAvatar(value: unknown): string {
  return typeof value === "string" && value.trim() && value.length <= 16
    ? value
    : DEFAULT_AVATAR_EMOJI;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fromClerkUser(user: {
  username: string | null;
  firstName: string | null;
  privateMetadata: Record<string, unknown>;
}): AccountProfile {
  const saved = getRecord(user.privateMetadata[PROFILE_METADATA_KEY]);
  const fallbackName = user.username ?? user.firstName ?? DEFAULT_USERNAME;
  return {
    username: normalizeProfileUsername(saved?.["username"] ?? fallbackName),
    avatarEmoji: normalizeProfileAvatar(saved?.["avatarEmoji"]),
  };
}

export async function getAccountProfile(userId: string): Promise<AccountProfile> {
  const user = await clerkClient.users.getUser(userId);
  return fromClerkUser(user);
}

export async function updateAccountProfile(
  userId: string,
  profile: AccountProfile,
): Promise<AccountProfile> {
  const existingUser = await clerkClient.users.getUser(userId);
  const user = await clerkClient.users.updateUserMetadata(userId, {
    privateMetadata: {
      ...existingUser.privateMetadata,
      [PROFILE_METADATA_KEY]: profile,
    },
  });
  return fromClerkUser(user);
}

/**
 * Snapshot of an account's display name and email at a point in time, used
 * for audit trails (e.g. moderation history) that must stay readable even if
 * the account is later renamed or deleted.
 */
export async function getAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  const user = await clerkClient.users.getUser(userId);
  const profile = fromClerkUser(user);
  const primaryEmail = user.emailAddresses.find(
    (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
  );
  return {
    userId,
    username: profile.username,
    email: primaryEmail?.emailAddress ?? null,
  };
}

export function normalizeAccountSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query.length >= MIN_ACCOUNT_SEARCH_QUERY_LENGTH ? query : null;
}

/**
 * Finds a small set of candidate accounts by display name or email so an
 * administrator can confirm the right account before changing its access.
 * Only the minimum fields needed for that decision are returned -- never the
 * full Clerk user record.
 */
export async function searchAccounts(query: string): Promise<AccountSearchResult[]> {
  const { data } = await clerkClient.users.getUserList({
    query,
    limit: MAX_ACCOUNT_SEARCH_RESULTS,
  });

  return data.map((user) => {
    const profile = fromClerkUser(user);
    const primaryEmail = user.emailAddresses.find(
      (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
    );
    return {
      userId: user.id,
      username: profile.username,
      avatarEmoji: profile.avatarEmoji,
      email: primaryEmail?.emailAddress ?? null,
      banned: isAccountBanned(user.privateMetadata),
    };
  });
}