import { describe, expect, it } from "vitest";
import * as apiClient from "./index";
import type { AuthTokenGetter } from "./index";

describe("API client public entrypoint", () => {
  it("re-exports generated API and schema modules", () => {
    expect(apiClient.healthCheck).toBeTypeOf("function");
    expect(apiClient.getProfile).toBeTypeOf("function");
    expect(apiClient.UserProfileAvatar).toEqual(
      expect.objectContaining({
        "🧑‍💻": "🧑‍💻",
      }),
    );
    expect(apiClient.PublicKeyConflictResponseCode).toEqual(
      expect.objectContaining({
        PUBLIC_KEY_CONFLICT: "PUBLIC_KEY_CONFLICT",
      }),
    );
  });

  it("re-exports the mobile base URL and auth-token helpers", () => {
    expect(apiClient.setBaseUrl).toBeTypeOf("function");
    expect(apiClient.setAuthTokenGetter).toBeTypeOf("function");

    const authTokenGetter: AuthTokenGetter = () => null;
    expect(authTokenGetter()).toBeNull();
  });
});