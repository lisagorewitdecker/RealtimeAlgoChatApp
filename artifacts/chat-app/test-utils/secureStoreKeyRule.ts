/**
 * The key-name rule of `expo-secure-store` (see `ensureValidKey` in its
 * build/SecureStore.js): on iOS and Android every read, write, and delete
 * rejects a key outside this alphabet before it reaches the keychain or
 * keystore.
 *
 * Test doubles for secure storage must call `ensureValidSecureStoreKey` so a
 * storage key that phones reject also fails the Jest run instead of passing
 * silently. `__tests__/secureStorageKey.test.ts` checks this rule against the
 * installed module, so a change in Expo's validation surfaces there.
 */
export const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/;

export const INVALID_SECURE_STORE_KEY_MESSAGE =
  'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".';

export function ensureValidSecureStoreKey(key: unknown): void {
  if (typeof key !== "string" || !SECURE_STORE_KEY_PATTERN.test(key)) {
    throw new Error(INVALID_SECURE_STORE_KEY_MESSAGE);
  }
}
