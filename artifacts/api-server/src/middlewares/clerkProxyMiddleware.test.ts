import { afterEach, describe, expect, it, vi } from "vitest";
import { getClerkProxyHost } from "./clerkProxyMiddleware";

describe("getClerkProxyHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts only deployment-configured hosts", () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "chat.example.com");
    vi.stubEnv("REPLIT_DOMAINS", "chat.example.com,api.example.com");

    expect(
      getClerkProxyHost({
        headers: { "x-forwarded-host": "chat.example.com" },
      }),
    ).toBe("chat.example.com");
    expect(
      getClerkProxyHost({
        headers: { "x-forwarded-host": "evil.example.com", host: "api.example.com" },
      }),
    ).toBe("api.example.com");
  });

  it.each([
    'evil.example.com"><script>alert(1)</script>',
    "trusted.example.com\r\nClerk-Proxy-Url: https://evil.example.com",
    "chat.example.com:65536",
  ])("rejects malformed or unconfigured host values: %s", (host) => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "chat.example.com");

    expect(
      getClerkProxyHost({
        headers: { "x-forwarded-host": host },
      }),
    ).toBeUndefined();
  });

  it("rejects all hosts when deployment domains are not configured", () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_INTERNAL_APP_DOMAIN", "");

    expect(
      getClerkProxyHost({
        headers: { "x-forwarded-host": "chat.example.com", host: "chat.example.com" },
      }),
    ).toBeUndefined();
  });
});
