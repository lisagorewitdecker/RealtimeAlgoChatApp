import { describe, expect, it, vi } from "vitest";
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
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