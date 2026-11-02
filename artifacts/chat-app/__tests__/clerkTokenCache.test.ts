import { Platform } from "react-native";
import { clerkTokenCache } from "../lib/clerkTokenCache";

describe("clerkTokenCache on web", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Platform.OS = "web";
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  it("keeps tokens in memory and removes them when cleared", async () => {
    await clerkTokenCache.saveToken("session", "token-value");

    await expect(clerkTokenCache.getToken("session")).resolves.toBe("token-value");

    await clerkTokenCache.clearToken("session");
    await expect(clerkTokenCache.getToken("session")).resolves.toBeNull();
  });
});
