declare module "tweetnacl" {
  interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  interface SecretBoxFn {
    (message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(
      box: Uint8Array,
      nonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array | null;
    keyLength: number;
    nonceLength: number;
    overheadLength: number;
  }

  interface BoxFn {
    (
      message: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array;
    open(
      box: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array | null;
    nonceLength: number;
    publicKeyLength: number;
    secretKeyLength: number;
    overheadLength: number;
    seedLength: number;
    keyPair: {
      (): KeyPair;
      fromSecretKey(secretKey: Uint8Array): KeyPair;
      fromSeed(seed: Uint8Array): KeyPair;
    };
  }

  interface NaclModule {
    randomBytes(length: number): Uint8Array;
    setPRNG(prng: (target: Uint8Array, length: number) => void): void;
    secretbox: SecretBoxFn;
    box: BoxFn;
  }

  const nacl: NaclModule;
  export default nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}