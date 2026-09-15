import nacl from "tweetnacl";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeUTF8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface ClientCrypto {
  encryptText(
    plaintext: string,
    roomKeyB64: string,
  ): { ciphertextB64: string; nonceB64: string } | null;
  decryptText(
    ciphertextB64: string,
    nonceB64: string,
    roomKeyB64: string,
  ): string | null;
}

const browserWindow = globalThis as typeof globalThis & {
  DevStudioCrypto?: ClientCrypto;
};

browserWindow.DevStudioCrypto = {
  encryptText(plaintext, roomKeyB64) {
    try {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      return {
        ciphertextB64: encodeBase64(
          nacl.secretbox(decodeUTF8(plaintext), nonce, decodeBase64(roomKeyB64)),
        ),
        nonceB64: encodeBase64(nonce),
      };
    } catch {
      return null;
    }
  },
  decryptText(ciphertextB64, nonceB64, roomKeyB64) {
    try {
      const plaintext = nacl.secretbox.open(
        decodeBase64(ciphertextB64),
        decodeBase64(nonceB64),
        decodeBase64(roomKeyB64),
      );
      return plaintext ? new TextDecoder().decode(plaintext) : null;
    } catch {
      return null;
    }
  },
};