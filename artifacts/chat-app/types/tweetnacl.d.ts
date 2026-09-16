declare module "tweetnacl" {
  import type nacl from "tweetnacl/nacl";
  export default nacl;
}

declare module "tweetnacl-util" {
  export const decodeBase64: (value: string) => Uint8Array;
  export const encodeBase64: (value: Uint8Array) => string;
  export const decodeUTF8: (value: string) => Uint8Array;
}