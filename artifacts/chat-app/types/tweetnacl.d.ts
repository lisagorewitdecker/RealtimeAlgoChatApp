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

  namespace BoxProps {
    interface Open {
      (
        box: Uint8Array,
        nonce: Uint8Array,
        publicKey: Uint8Array,
        secretKey: Uint8Array,
      ): Uint8Array | null;
      after(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    }

    interface KeyPairFactory {
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
    open: BoxProps.Open;
    keyPair: BoxProps.KeyPairFactory;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly sharedKeyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  namespace SignProps {
    interface Detached {
      (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
    }

    interface KeyPairFactory {
      (): SignKeyPair;
      fromSecretKey(secretKey: Uint8Array): SignKeyPair;
      fromSeed(seed: Uint8Array): SignKeyPair;
    }
  }

  interface Sign {
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(signedMsg: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
    detached: SignProps.Detached;
    keyPair: SignProps.KeyPairFactory;
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
  export = nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}