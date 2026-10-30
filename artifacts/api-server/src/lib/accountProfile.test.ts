import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { updateAccountProfile } from "./accountProfile.js";

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
