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

import {
  ACCOUNT_ACCESS_MAX_ATTEMPTS,
  ACCOUNT_ACCESS_RETRY_BUDGET_MS,
  getAccountAccess,
  setAccountBan,
} from "./accountAccess.js";
import {
  AccountAccessDeadlineError,
  AccountAccessUnavailableError,
} from "./accountAccessUnavailable.js";
import { MAX_CLERK_RETRY_DELAY_MS } from "./clerkRetry.js";

function throttledError(retryAfter: number) {
  return Object.assign(new Error("Too Many Requests"), {
    status: 429,
    retryAfter,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the lookup to reject");
}

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

  it("keeps every attempt and delay when the waits fit within the budget", async () => {
    vi.useFakeTimers();
    const retryAfterSeconds = 3;
    const totalWaitMs =
      (ACCOUNT_ACCESS_MAX_ATTEMPTS - 1) * retryAfterSeconds * 1_000;
    expect(totalWaitMs).toBeLessThanOrEqual(ACCOUNT_ACCESS_RETRY_BUDGET_MS);
    const throttled = throttledError(retryAfterSeconds);
    mockGetUser.mockRejectedValue(throttled);

    const failure = rejection(getAccountAccess("user-within-budget"));
    for (let attempt = 1; attempt < ACCOUNT_ACCESS_MAX_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(retryAfterSeconds * 1_000 - 1);
      expect(mockGetUser).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockGetUser).toHaveBeenCalledTimes(attempt + 1);
    }

    const error = await failure;
    expect(error).toBeInstanceOf(AccountAccessUnavailableError);
    expect(error).toMatchObject({
      attempts: ACCOUNT_ACCESS_MAX_ATTEMPTS,
      retryAfterMs: retryAfterSeconds * 1_000,
      retryAfterSeconds,
      status: 429,
      cause: throttled,
    });
    expect(mockGetUser).toHaveBeenCalledTimes(ACCOUNT_ACCESS_MAX_ATTEMPTS);
    vi.useRealTimers();
  });

  it("stops retrying once the next wait would exceed the lookup budget", async () => {
    vi.useFakeTimers();
    // Two thirds of the budget: one wait fits, a second one would not.
    const retryAfterMs = (ACCOUNT_ACCESS_RETRY_BUDGET_MS * 2) / 3;
    const throttled = throttledError(retryAfterMs / 1_000);
    mockGetUser.mockRejectedValue(throttled);

    const failure = rejection(getAccountAccess("user-budget-exhausted"));
    await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetUser).toHaveBeenCalledTimes(2);

    const error = await failure;
    expect(error).toBeInstanceOf(AccountAccessUnavailableError);
    expect(error).toMatchObject({
      attempts: 2,
      retryAfterMs,
      retryAfterSeconds: retryAfterMs / 1_000,
      status: 429,
      cause: throttled,
    });
    // Rejected as soon as the second attempt failed: nothing left sleeping.
    expect(vi.getTimerCount()).toBe(0);
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("answers at the budget deadline when a Clerk request never settles", async () => {
    vi.useFakeTimers();
    mockGetUser.mockImplementation(() => new Promise(() => undefined));
    let settled = false;

    const failure = rejection(getAccountAccess("user-hung-clerk")).finally(
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(ACCOUNT_ACCESS_RETRY_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const error = await failure;
    expect(error).toBeInstanceOf(AccountAccessUnavailableError);
    expect(error).toMatchObject({
      attempts: 1,
      retryAfterMs: 250,
      retryAfterSeconds: 1,
      status: undefined,
      cause: expect.any(AccountAccessDeadlineError),
    });
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("cuts a retry short at the deadline instead of letting it outlive the budget", async () => {
    vi.useFakeTimers();
    const requestMs = 8_000;
    const retryAfterMs = 5_000;
    const throttled = throttledError(retryAfterMs / 1_000);
    // Each request takes 8 s: the first fails at 8 s, 8 s + 5 s still fits,
    // so a retry starts at 13 s -- and must be abandoned at the 15 s deadline
    // rather than run until 21 s.
    mockGetUser.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(throttled), requestMs),
        ),
    );
    let settled = false;

    const failure = rejection(getAccountAccess("user-slow-clerk")).finally(
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(requestMs + retryAfterMs);
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_ACCESS_RETRY_BUDGET_MS - requestMs - retryAfterMs - 1,
    );
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const error = await failure;
    expect(error).toMatchObject({
      attempts: 2,
      retryAfterSeconds: 1,
      cause: expect.any(AccountAccessDeadlineError),
    });
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    // Only the abandoned request's own (mock) timer remains; the lookup
    // itself holds nothing.
    expect(vi.getTimerCount()).toBe(1);
    vi.useRealTimers();
  });

  it("ignores a late answer from a request that lost the deadline race", async () => {
    vi.useFakeTimers();
    let answerLate: (() => void) | undefined;
    mockGetUser
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerLate = () => resolve(clerkUser());
          }),
      )
      .mockResolvedValueOnce(clerkUser({ privateMetadata: { devStudioAccess: { banned: true } } }));

    const first = rejection(getAccountAccess("user-late-answer"));
    await vi.advanceTimersByTimeAsync(ACCOUNT_ACCESS_RETRY_BUDGET_MS);
    await expect(first).resolves.toBeInstanceOf(AccountAccessUnavailableError);

    answerLate?.();
    await vi.advanceTimersByTimeAsync(0);
    // The stale allow verdict is discarded: a fresh lookup reaches Clerk
    // again and sees the current (banned) state.
    await expect(getAccountAccess("user-late-answer")).resolves.toEqual({
      allowed: false,
      reason: "banned",
    });
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each([30, 31, 3_600, Number.MAX_SAFE_INTEGER])(
    "gives up at once with a hint capped at the shared ceiling when Clerk asks for %s seconds",
    async (retryAfter) => {
      vi.useFakeTimers();
      expect(MAX_CLERK_RETRY_DELAY_MS).toBeGreaterThan(
        ACCOUNT_ACCESS_RETRY_BUDGET_MS,
      );
      const throttled = throttledError(retryAfter);
      mockGetUser.mockRejectedValue(throttled);

      const error = await rejection(
        getAccountAccess(`user-capped-${String(retryAfter)}`),
      );

      expect(error).toBeInstanceOf(AccountAccessUnavailableError);
      expect(error).toMatchObject({
        attempts: 1,
        retryAfterMs: MAX_CLERK_RETRY_DELAY_MS,
        retryAfterSeconds: MAX_CLERK_RETRY_DELAY_MS / 1_000,
        status: 429,
        cause: throttled,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    },
  );

  it.each([
    ["a non-retryable Clerk status", Object.assign(new Error("Not Found"), { status: 404 })],
    ["a network failure", new TypeError("fetch failed")],
  ])("fails immediately with a minimal hint on %s", async (_label, cause) => {
    vi.useFakeTimers();
    mockGetUser.mockRejectedValue(cause);

    const error = await rejection(getAccountAccess("user-not-retryable"));

    expect(error).toBeInstanceOf(AccountAccessUnavailableError);
    expect(error).toMatchObject({
      attempts: 1,
      retryAfterMs: 250,
      retryAfterSeconds: 1,
      cause,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
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
