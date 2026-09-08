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

import { getAccountAccess, setAccountBan } from "./accountAccess.js";

function clerkUser({
  verified = true,
  privateMetadata = {},
}: {
  verified?: boolean;
  privateMetadata?: Record<string, unknown>;
} = {}) {
  return {
    primaryEmailAddressId: "email-primary",
    emailAddresses: [
      {
        id: "email-primary",
        verification: { status: verified ? "verified" : "unverified" },
      },
    ],
    privateMetadata,
  };
}

describe("account access", () => {
  beforeEach(() => {
    mockGetUser.mockReset().mockResolvedValue(clerkUser());
    mockUpdateUserMetadata.mockReset().mockResolvedValue(clerkUser());
  });

  it("allows a verified account without a ban", async () => {
    await expect(getAccountAccess("user-ada")).resolves.toEqual({ allowed: true });
  });

  it("rejects an account whose primary email is not verified", async () => {
    mockGetUser.mockResolvedValue(clerkUser({ verified: false }));
    await expect(getAccountAccess("user-ada")).resolves.toEqual({
      allowed: false,
      reason: "unverified",
    });
  });

  it("rejects a banned account even when its email is verified", async () => {
    mockGetUser.mockResolvedValue(
      clerkUser({ privateMetadata: { devStudioAccess: { banned: true } } }),
    );
    await expect(getAccountAccess("user-ada")).resolves.toEqual({
      allowed: false,
      reason: "banned",
    });
  });

  it("retries a throttled Clerk lookup before denying account access", async () => {
    vi.useFakeTimers();
    mockGetUser
      .mockRejectedValueOnce(
        Object.assign(new Error("Too Many Requests"), {
          status: 429,
          retryAfter: 0,
        }),
      )
      .mockResolvedValueOnce(clerkUser());

    const access = getAccountAccess("user-ada");
    await vi.runAllTimersAsync();

    await expect(access).resolves.toEqual({ allowed: true });
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("persists a ban without overwriting the account profile metadata", async () => {
    mockGetUser.mockResolvedValue(
      clerkUser({
        privateMetadata: {
          devStudioProfile: { username: "Ada", avatarEmoji: "👩‍💻" },
        },
      }),
    );

    await setAccountBan("user-ada", true);

    expect(mockUpdateUserMetadata).toHaveBeenCalledWith(
      "user-ada",
      expect.objectContaining({
        privateMetadata: expect.objectContaining({
          devStudioProfile: { username: "Ada", avatarEmoji: "👩‍💻" },
          devStudioAccess: expect.objectContaining({ banned: true }),
        }),
      }),
    );
  });
});
