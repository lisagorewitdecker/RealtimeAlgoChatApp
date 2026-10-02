declare module "tweetnacl" {
  interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  interface Secretbox {
    (message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    keyLength: number;
    nonceLength: number;
  }

  interface Box {
    (message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(
      ciphertext: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array | null;
    nonceLength: number;
    secretKeyLength: number;
    keyPair: {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
    };
  }

  interface Nacl {
    box: Box;
    randomBytes(length: number): Uint8Array;
    secretbox: Secretbox;
    setPRNG(callback: (target: Uint8Array, length: number) => void): void;
  }

  const nacl: Nacl;
  export default nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}