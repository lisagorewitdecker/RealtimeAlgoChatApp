import { describe, expect, it, vi } from "vitest";
import {
  getAnthropicRetryAfterSeconds,
  getAssistantRateLimitCountdown,
} from "./assistantErrors.js";

describe("assistant rate-limit countdown", () => {
  it("starts from the provider's retryAfter value when present", () => {
    expect(getAssistantRateLimitCountdown(12)).toBe(12);
  });

  it("falls back to 30 seconds when retryAfter is absent", () => {
    expect(getAssistantRateLimitCountdown(undefined)).toBe(30);
  });
});

describe("Anthropic Retry-After parsing", () => {
  it("uses numeric retry-after seconds", () => {
    expect(
      getAnthropicRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "12" },
      }),
    ).toBe(12);
  });

  it("converts a retry-after timestamp into remaining wait seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));

    expect(
      getAnthropicRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "Sun, 23 Aug 2026 12:00:12 GMT" },
      }),
    ).toBe(12);

    vi.useRealTimers();
  });

  it("rejects malformed and expired retry-after values", () => {
    expect(
      getAnthropicRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "not-a-retry-time" },
      }),
    ).toBeUndefined();
    expect(
      getAnthropicRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "Sun, 23 Aug 2026 11:59:59 GMT" },
      }),
    ).toBeUndefined();
  });
});