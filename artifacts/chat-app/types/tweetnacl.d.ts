declare module "tweetnacl" {
  export interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface SignKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface SecretBox {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    readonly keyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  export interface ScalarMult {
    (n: Uint8Array, p: Uint8Array): Uint8Array;
    base(n: Uint8Array): Uint8Array;
    readonly scalarLength: number;
    readonly groupElementLength: number;
  }

  export interface BoxOpen {
    (
      msg: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array | null;
    after(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
  }

  export interface BoxKeyPairFactory {
    (): BoxKeyPair;
    fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
  }

  export interface Box {
    (
      msg: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array;
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    after(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open: BoxOpen;
    keyPair: BoxKeyPairFactory;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly sharedKeyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  export interface DetachedSign {
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
    verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
  }

  export interface SignKeyPairFactory {
    (): SignKeyPair;
    fromSecretKey(secretKey: Uint8Array): SignKeyPair;
    fromSeed(seed: Uint8Array): SignKeyPair;
  }

  export interface Sign {
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(signedMsg: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
    detached: DetachedSign;
    keyPair: SignKeyPairFactory;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly seedLength: number;
    readonly signatureLength: number;
  }

  export interface Hash {
    (msg: Uint8Array): Uint8Array;
    readonly hashLength: number;
  }

  export interface Nacl {
    randomBytes(n: number): Uint8Array;
    secretbox: SecretBox;
    scalarMult: ScalarMult;
    box: Box;
    sign: Sign;
    hash: Hash;
    verify(x: Uint8Array, y: Uint8Array): boolean;
    setPRNG(fn: (x: Uint8Array, n: number) => void): void;
  }

  const nacl: Nacl;
  export default nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}