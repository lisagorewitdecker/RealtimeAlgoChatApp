import {
  getClerkConfiguration,
} from "../lib/clerkConfig";

describe("Clerk mobile configuration", () => {
  it("accepts the public Expo environment mapping", () => {
    expect(
      getClerkConfiguration({
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_expo_key",
      }),
    ).toMatchObject({
      status: "ready",
      publishableKey: "pk_test_expo_key",
      source: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    });
  });

  it("accepts the managed Vite environment mapping", () => {
    expect(
      getClerkConfiguration({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_live_managed_key",
      }),
    ).toMatchObject({
      status: "ready",
      publishableKey: "pk_live_managed_key",
      source: "VITE_CLERK_PUBLISHABLE_KEY",
    });
  });

  it("prefers the Expo public mapping when both inputs exist", () => {
    expect(
      getClerkConfiguration({
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_expo_key",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_vite_key",
      }),
    ).toMatchObject({
      status: "ready",
      publishableKey: "pk_test_expo_key",
    });
  });

  it("returns a safe actionable state when the key is missing", () => {
    const configuration = getClerkConfiguration({});

    expect(configuration.status).toBe("missing");
    if (configuration.status === "ready") {
      throw new Error("Expected missing Clerk configuration");
    }
    expect(configuration.message).toMatch(/project owner/i);
    expect(configuration.message).not.toMatch(/pk_/);
  });

  it("returns a safe actionable state when the key is malformed", () => {
    const configuration = getClerkConfiguration({
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "not-a-clerk-key",
    });

    expect(configuration.status).toBe("invalid");
    if (configuration.status === "ready") {
      throw new Error("Expected invalid Clerk configuration");
    }
    expect(configuration.message).toMatch(/not valid/i);
    expect(configuration.message).not.toContain("not-a-clerk-key");
  });
});