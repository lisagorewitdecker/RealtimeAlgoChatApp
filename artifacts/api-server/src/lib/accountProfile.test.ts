import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.hoisted(() => vi.fn());
const mockUpdateUserMetadata = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: mockGetUser,
      updateUserMetadata: mockUpdateUserMetadata,
    },
  },
}));

import { getAccountProfile, updateAccountProfile } from "./accountProfile.js";

describe("updateAccountProfile", () => {
  beforeEach(() => {
    // A stale read taken before an administrator banned the account.
    mockGetUser.mockReset().mockResolvedValue({
      username: null,
      firstName: "Ada",
      privateMetadata: {
        devStudioAccess: { banned: false, bannedAt: null },
        devStudioProfile: { username: "Ada", avatarEmoji: "🦊" },
      },
    });
    mockUpdateUserMetadata.mockReset().mockResolvedValue({
      username: null,
      firstName: "Ada",
      privateMetadata: {
        devStudioAccess: { banned: true, bannedAt: "2026-01-01T00:00:00.000Z" },
        devStudioProfile: { username: "Ada Lovelace", avatarEmoji: "👩‍💻" },
      },
    });
  });

  it("writes only the profile key so a concurrent ban is never overwritten", async () => {
    const profile = await updateAccountProfile("user-ada", {
      username: "Ada Lovelace",
      avatarEmoji: "👩‍💻",
    });

    expect(mockUpdateUserMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateUserMetadata).toHaveBeenCalledWith("user-ada", {
      privateMetadata: {
        devStudioProfile: { username: "Ada Lovelace", avatarEmoji: "👩‍💻" },
      },
    });
    expect(profile).toEqual({ username: "Ada Lovelace", avatarEmoji: "👩‍💻" });
  });
});

describe("getAccountProfile display-name fallback", () => {
  function clerkUser(overrides: Record<string, unknown>) {
    return {
      id: "user-ada",
      username: null,
      firstName: null,
      privateMetadata: {},
      primaryEmailAddressId: "email-1",
      emailAddresses: [{ id: "email-1", emailAddress: "ada@example.com" }],
      ...overrides,
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not adopt a reserved Clerk name for a non-admin account", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    mockGetUser.mockResolvedValue(clerkUser({ firstName: "Ѕystem" }));

    await expect(getAccountProfile("user-ada")).resolves.toEqual({
      username: "Member",
      avatarEmoji: "🧑‍💻",
    });
  });

  it("keeps a reserved Clerk name for a configured administrator", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "user-ada");
    mockGetUser.mockResolvedValue(clerkUser({ username: "System" }));

    await expect(getAccountProfile("user-ada")).resolves.toMatchObject({
      username: "System",
    });
  });

  it("keeps a reserved Clerk name for the MAIN_ADMIN_EMAIL account", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    vi.stubEnv("MAIN_ADMIN_EMAIL", "ADA@example.com");
    mockGetUser.mockResolvedValue(
      clerkUser({ firstName: "Lisa Gorewit-Decker" }),
    );

    await expect(getAccountProfile("user-ada")).resolves.toMatchObject({
      username: "Lisa Gorewit-Decker",
    });
  });

  it("still renders a stored reserved name instead of failing the load", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    mockGetUser.mockResolvedValue(
      clerkUser({
        privateMetadata: {
          devStudioProfile: { username: "System", avatarEmoji: "🐢" },
        },
      }),
    );

    await expect(getAccountProfile("user-ada")).resolves.toEqual({
      username: "System",
      avatarEmoji: "🐢",
    });
  });
});
