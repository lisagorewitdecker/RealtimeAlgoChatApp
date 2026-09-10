/**
 * Key naming for `expo-secure-store`.
 *
 * On iOS and Android, secure storage only accepts key names matching /^[\w.-]+$/.
 * The app's logical storage keys use ":" separators (for example
 * `devstudio_roomkey:<userId>:<roomId>`), which the keychain/keystore rejects, so
 * every native read and write goes through this encoding first.
 *
 * The encoding is injective: each character outside [A-Za-z0-9_-] is replaced by
 * its UTF-8 bytes written as "." followed by exactly two hex digits, and "." is
 * never emitted literally. Two different logical keys can therefore never share
 * a storage key, and the result stays readable (":" becomes ".3a").
 *
 * Web storage is unaffected; browsers accept the logical keys as-is and already
 * hold data under them.
 */
const SAFE_CHARACTER = /^[A-Za-z0-9_-]$/;

let encoder: TextEncoder | null = null;

function utf8Bytes(character: string): Uint8Array {
  encoder ??= new TextEncoder();
  return encoder.encode(character);
}

export function toSecureStoreKey(logicalKey: string): string {
  if (!logicalKey) {
    throw new Error("Secure storage keys must not be empty.");
  }
  let encoded = "";
  for (const character of logicalKey) {
    if (SAFE_CHARACTER.test(character)) {
      encoded += character;
      continue;
    }
    for (const byte of utf8Bytes(character)) {
      encoded += `.${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return encoded;
}
