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
import { MAX_CLERK_RETRY_DELAY_MS } from "./clerkRetry.js";

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

  it("interprets numeric Clerk retry guidance as seconds", async () => {
    vi.useFakeTimers();
    mockGetUser
      .mockRejectedValueOnce({ status: 429, retryAfter: 3 })
      .mockResolvedValueOnce(clerkUser());

    const access = getAccountAccess("user-numeric-retry");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(access).resolves.toEqual({ allowed: true });
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each([30, 31, 3_600, Number.MAX_SAFE_INTEGER])(
    "caps Clerk retry guidance of %s seconds at the shared ceiling",
    async (retryAfter) => {
      vi.useFakeTimers();
      mockGetUser
        .mockRejectedValueOnce({ status: 429, retryAfter })
        .mockResolvedValueOnce(clerkUser());

      const access = getAccountAccess(`user-capped-${String(retryAfter)}`);
      await vi.advanceTimersByTimeAsync(MAX_CLERK_RETRY_DELAY_MS - 1);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(access).resolves.toEqual({ allowed: true });
      expect(mockGetUser).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    },
  );

  it("keeps the attempt count when every retry hint exceeds the ceiling", async () => {
    vi.useFakeTimers();
    const throttled = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      retryAfter: 3_600,
    });
    mockGetUser.mockRejectedValue(throttled);

    const access = getAccountAccess("user-capped-exhausted");
    access.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3 * MAX_CLERK_RETRY_DELAY_MS - 1);
    expect(mockGetUser).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(access).rejects.toBe(throttled);
    expect(mockGetUser).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it.each(["later", Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "falls back to bounded backoff for malformed retry guidance %s",
    async (retryAfter) => {
      vi.useFakeTimers();
      mockGetUser
        .mockRejectedValueOnce({ status: 429, retryAfter })
        .mockResolvedValueOnce(clerkUser());

      const access = getAccountAccess(`user-malformed-${String(retryAfter)}`);
      await vi.advanceTimersByTimeAsync(249);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(access).resolves.toEqual({ allowed: true });
      expect(mockGetUser).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    },
  );

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
