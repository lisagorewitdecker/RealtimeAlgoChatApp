import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin } from "./origins";

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