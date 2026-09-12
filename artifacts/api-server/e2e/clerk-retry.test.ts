import { describe, expect, it, vi } from "vitest";
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
  withClerkSetupRetry,
} from "./clerk-retry.js";

describe("withClerkRetry", () => {
  it.each([429, 500, 502, 503, 504])(
    "retries Clerk status %i",
    async (status) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status })
        .mockResolvedValue("created");
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await expect(
        withClerkRetry("create user", operation, {
          attempts: 2,
          baseDelayMs: 10,
          sleep,
        }),
      ).resolves.toBe("created");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(10);
    },
  );

  it("supports Clerk errors that expose statusCode", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ statusCode: 502 })
      .mockResolvedValue("token");

    await expect(
      withClerkRetry("mint token", operation, {
        attempts: 2,
        baseDelayMs: 0,
      }),
    ).resolves.toBe("token");
  });

  it("uses numeric Clerk retry guidance when it exceeds backoff", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429, retryAfter: 3 })
      .mockResolvedValue("session");
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      withClerkRetry("create session", operation, {
        attempts: 2,
        baseDelayMs: 10,
        sleep,
      }),
    ).resolves.toBe("session");
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it.each(["later", Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "falls back to exponential backoff for malformed retry guidance %s",
    async (retryAfter) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 429, retryAfter })
        .mockResolvedValue("session");
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await withClerkRetry("create session", operation, {
        attempts: 2,
        baseDelayMs: 25,
        sleep,
      });
      expect(sleep).toHaveBeenCalledWith(25);
    },
  );

  it("uses bounded exponential backoff when retry guidance is absent", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue("session");
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await withClerkRetry("create session", operation, {
      attempts: 3,
      baseDelayMs: 20_000,
      sleep,
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 20_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("does not retry permanent failures", async () => {
    const failure = { status: 400 };
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      withClerkRetry("create session", operation, {
        attempts: 5,
        baseDelayMs: 0,
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("withClerkSetupRetry", () => {
  it("retries temporary Clerk setup failures with bounded backoff", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue();
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      withClerkSetupRetry(operation, {
        attempts: 3,
        baseDelayMs: 25,
        sleep,
      }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
  });

  it.each([401, 403])(
    "fails immediately for permanent Clerk setup status %i",
    async (status) => {
      const failure = { status };
      const operation = vi.fn().mockRejectedValue(failure);
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await expect(
        withClerkSetupRetry(operation, {
          attempts: 5,
          baseDelayMs: 25,
          sleep,
        }),
      ).rejects.toBe(failure);
      expect(operation).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});

describe("throwTestAndCleanupFailures", () => {
  it("retains both the original test failure and cleanup failures", () => {
    const testFailure = new Error("assertion failed");
    const cleanupFailure = new Error("delete failed");

    expect(() =>
      throwTestAndCleanupFailures(
        testFailure,
        [cleanupFailure],
        "cleanup failed",
        "test and cleanup failed",
      ),
    ).toThrow(
      expect.objectContaining({
        message: "test and cleanup failed",
        errors: [testFailure, cleanupFailure],
      }),
    );
  });

  it("rethrows the original failure when cleanup succeeds", () => {
    const testFailure = new Error("assertion failed");
    expect(() =>
      throwTestAndCleanupFailures(
        testFailure,
        [],
        "cleanup failed",
        "test and cleanup failed",
      ),
    ).toThrow(testFailure);
  });
});