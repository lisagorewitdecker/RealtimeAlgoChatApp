import { toSecureStoreKey } from "../lib/secureStorageKey";
import {
  INVALID_SECURE_STORE_KEY_MESSAGE,
  SECURE_STORE_KEY_PATTERN,
  ensureValidSecureStoreKey,
} from "../test-utils/secureStoreKeyRule";

describe("toSecureStoreKey", () => {
  it("leaves keys that secure storage already accepts unchanged", () => {
    expect(toSecureStoreKey("devstudio_accessibility_prefs")).toBe(
      "devstudio_accessibility_prefs",
    );
    expect(toSecureStoreKey("user_2abcDEF-09")).toBe("user_2abcDEF-09");
  });

  it("encodes the colon-separated room and device key names into accepted names", () => {
    const roomKey = toSecureStoreKey("devstudio_roomkey:user_2abc:room-42");
    const deviceKey = toSecureStoreKey("devstudio_device_keypair_v1:user_2abc");

    expect(roomKey).toBe("devstudio_roomkey.3auser_2abc.3aroom-42");
    expect(deviceKey).toBe("devstudio_device_keypair_v1.3auser_2abc");
    expect(roomKey).toMatch(SECURE_STORE_KEY_PATTERN);
    expect(deviceKey).toMatch(SECURE_STORE_KEY_PATTERN);
  });

  it("is deterministic", () => {
    expect(toSecureStoreKey("devstudio_roomkey:u:r")).toBe(
      toSecureStoreKey("devstudio_roomkey:u:r"),
    );
  });

  it("never lets two different logical keys collide", () => {
    const logicalKeys = [
      "devstudio_roomkey:u_1:room",
      "devstudio_roomkey:u:1_room",
      "devstudio_roomkey:u.1:room",
      "devstudio_roomkey:u:1.room",
      "devstudio_roomkey:u:1:room",
      "devstudio_roomkey:u.3a1:room",
      "devstudio_roomkey:ü:room",
      "devstudio_roomkey:u:room ",
      "a:b",
      "a.b",
      "a%3Ab",
      "a_b",
    ];
    const encoded = logicalKeys.map(toSecureStoreKey);
    expect(new Set(encoded).size).toBe(logicalKeys.length);
    for (const key of encoded) {
      expect(key).toMatch(SECURE_STORE_KEY_PATTERN);
    }
  });

  it("encodes multi-byte characters by their UTF-8 bytes", () => {
    expect(toSecureStoreKey("ü")).toBe(".c3.bc");
    expect(toSecureStoreKey("😀")).toBe(".f0.9f.98.80");
  });

  it("rejects empty keys instead of producing an invalid name", () => {
    expect(() => toSecureStoreKey("")).toThrow("must not be empty");
  });
});

// The rule the test doubles enforce must be the rule of the installed module.
// expo-secure-store validates key names in JavaScript before touching the
// native module, so its verdict is observable here without a keychain.
describe("expo-secure-store key rule", () => {
  const realSecureStore = jest.requireActual(
    "expo-secure-store",
  ) as typeof import("expo-secure-store");

  it("matches the installed module: logical keys are rejected before any native call", async () => {
    for (const logicalKey of [
      "devstudio_roomkey:user_2abc:room-42",
      "devstudio_device_keypair_v1:user_2abc",
      "",
    ]) {
      await expect(realSecureStore.setItemAsync(logicalKey, "value")).rejects.toThrow(
        INVALID_SECURE_STORE_KEY_MESSAGE,
      );
      await expect(realSecureStore.getItemAsync(logicalKey)).rejects.toThrow(
        INVALID_SECURE_STORE_KEY_MESSAGE,
      );
      expect(() => ensureValidSecureStoreKey(logicalKey)).toThrow(
        INVALID_SECURE_STORE_KEY_MESSAGE,
      );
    }
  });

  it("matches the installed module: encoded keys pass its name validation", async () => {
    const encodedKey = toSecureStoreKey("devstudio_roomkey:user_2abc:ana's/déjà 🚀");
    expect(() => ensureValidSecureStoreKey(encodedKey)).not.toThrow();
    // Past validation the call reaches the (absent) native module; whatever
    // happens there, it must not be the key-name rejection.
    const outcome = await realSecureStore
      .setItemAsync(encodedKey, "value")
      .then(() => "accepted", (error: unknown) => String(error));
    expect(outcome).not.toContain("Invalid key provided to SecureStore");
  });
});
