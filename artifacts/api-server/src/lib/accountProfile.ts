import { clerkClient } from "@clerk/express";
import { isAccountBanned, isConfiguredAdmin } from "./accountAccess";
import { isMainAdminEmail, mayUseDisplayName } from "./profileIdentity";

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

interface ClerkProfileSource {
  id?: string;
  username: string | null;
  firstName: string | null;
  privateMetadata: Record<string, unknown>;
  primaryEmailAddressId?: string | null;
  emailAddresses?: { id: string; emailAddress: string }[];
}

function primaryEmailOf(user: ClerkProfileSource): string | null {
  return (
    user.emailAddresses?.find(
      (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
    )?.emailAddress ?? null
  );
}

/**
 * The Clerk username and first name are user-editable outside this API, so a
 * reserved display name there is not used as the fallback for non-admins.
 */
function fallbackDisplayName(user: ClerkProfileSource): string {
  const name = normalizeProfileUsername(
    user.username ?? user.firstName ?? DEFAULT_USERNAME,
  );
  if (
    !mayUseDisplayName(name, {
      isConfiguredAdmin: Boolean(user.id && isConfiguredAdmin(user.id)),
      isMainAdmin: isMainAdminEmail(primaryEmailOf(user)),
    })
  ) {
    return DEFAULT_USERNAME;
  }
  return name;
}

function fromClerkUser(user: ClerkProfileSource): AccountProfile {
  const saved = getRecord(user.privateMetadata[PROFILE_METADATA_KEY]);
  return {
    username: normalizeProfileUsername(
      saved?.["username"] ?? fallbackDisplayName(user),
    ),
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
  // Clerk deep-merges metadata updates, so write only the profile key. Echoing
  // a previously read copy of the other keys could undo a concurrent ban.
  const user = await clerkClient.users.updateUserMetadata(userId, {
    privateMetadata: {
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