declare module "tweetnacl" {
  interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  interface SignKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  interface SecretBox {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    readonly keyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  interface ScalarMult {
    (n: Uint8Array, p: Uint8Array): Uint8Array;
    base(n: Uint8Array): Uint8Array;
    readonly scalarLength: number;
    readonly groupElementLength: number;
  }

  namespace boxProps {
    interface open {
      (
        box: Uint8Array,
        nonce: Uint8Array,
        publicKey: Uint8Array,
        secretKey: Uint8Array,
      ): Uint8Array | null;
      after(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    }

    interface keyPair {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
    }
  }

  interface Box {
    (
      msg: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array;
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    after(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open: boxProps.open;
    keyPair: boxProps.keyPair;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly sharedKeyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  namespace signProps {
    interface detached {
      (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
    }

    interface keyPair {
      (): SignKeyPair;
      fromSecretKey(secretKey: Uint8Array): SignKeyPair;
      fromSeed(secretKey: Uint8Array): SignKeyPair;
    }
  }

  interface Sign {
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(signedMsg: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
    detached: signProps.detached;
    keyPair: signProps.keyPair;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly seedLength: number;
    readonly signatureLength: number;
  }

  interface Hash {
    (msg: Uint8Array): Uint8Array;
    readonly hashLength: number;
  }

  interface NaclModule {
    randomBytes(n: number): Uint8Array;
    secretbox: SecretBox;
    scalarMult: ScalarMult;
    box: Box;
    sign: Sign;
    hash: Hash;
    verify(x: Uint8Array, y: Uint8Array): boolean;
    setPRNG(fn: (x: Uint8Array, n: number) => void): void;
  }

  const nacl: NaclModule;
  export default nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}