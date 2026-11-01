import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin, isAuthorizedParty } from "./origins";

describe("CORS origins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows the Expo preview domain used by browser-based mobile previews", () => {
    vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", "expo-preview.example.test");

    expect(isAllowedOrigin("https://expo-preview.example.test")).toBe(true);
  });

  it("does not allow an unrelated browser origin", () => {
    vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", "expo-preview.example.test");

    expect(isAllowedOrigin("https://untrusted.example.test")).toBe(false);
  });
});

describe("Clerk authorized party (azp) check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubDeploymentDomains() {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_DOMAINS", "chat.example.test,www.example.test");
    vi.stubEnv("REPLIT_INTERNAL_APP_DOMAIN", "");
  }

  it("accepts a token minted on a deployment origin", () => {
    stubDeploymentDomains();

    expect(isAuthorizedParty("https://chat.example.test")).toBe(true);
    expect(isAuthorizedParty("https://www.example.test")).toBe(true);
  });

  it("rejects a token minted on any other origin", () => {
    stubDeploymentDomains();

    expect(isAuthorizedParty("https://attacker.example.test")).toBe(false);
    expect(isAuthorizedParty("http://chat.example.test")).toBe(false);
    expect(isAuthorizedParty(["https://chat.example.test"])).toBe(false);
  });

  it("accepts native tokens, which carry no azp claim", () => {
    stubDeploymentDomains();

    expect(isAuthorizedParty(undefined)).toBe(true);
    expect(isAuthorizedParty("")).toBe(true);
  });

  it("accepts every party when no deployment domain is configured", () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_INTERNAL_APP_DOMAIN", "");

    expect(isAuthorizedParty("https://localhost:8081")).toBe(true);
  });
});
