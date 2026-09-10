import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useAuth } from "@clerk/expo";
import nacl from "tweetnacl";
import { decodeBase64, decodeUTF8, encodeBase64 } from "tweetnacl-util";
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { toSecureStoreKey } from "@/lib/secureStorageKey";

nacl.setPRNG((target: Uint8Array, length: number) => target.set(ExpoCrypto.getRandomBytes(length)));

const deviceKeypairStorageKey = (userId: string) =>
  `devstudio_device_keypair_v1:${userId}`;
const roomStorageKey = (userId: string, roomId: string) =>
  `devstudio_roomkey:${userId}:${roomId}`;
const PUBLIC_KEY_SYNC_RETRY_DELAYS_MS = [250, 750, 2_000, 5_000] as const;

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// Native secure storage rejects the ":" separators used in the logical keys
// above, so they are encoded (see lib/secureStorageKey.ts). Web keeps the
// logical key because browser storage already holds data under it.
async function getStored(key: string) {
  return Platform.OS === "web"
    ? globalThis.localStorage?.getItem(key) ?? null
    : SecureStore.getItemAsync(toSecureStoreKey(key));
}
async function setStored(key: string, value: string) {
  if (Platform.OS === "web") {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("Browser storage is unavailable.");
    storage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(toSecureStoreKey(key), value);
  }
}

export interface CryptoContextValue {
  publicKeyB64: string;
  isReady: boolean;
  roomKeys: Map<string, Uint8Array>;
  decryptRoomKeyEnvelope: (ciphertextB64: string, nonceB64: string, senderPublicKeyB64: string) => Uint8Array | null;
  encryptRoomKey: (roomKey: Uint8Array, recipientPublicKeyB64: string) => { ciphertextB64: string; nonceB64: string } | null;
  encryptMessage: (plaintext: string, roomId: string) => { ciphertextB64: string; nonceB64: string } | null;
  decryptMessage: (ciphertextB64: string, nonceB64: string, roomId: string) => string | null;
  encryptBytes: (data: Uint8Array, roomId: string) => { ciphertextB64: string; nonceB64: string } | null;
  decryptBytes: (ciphertextB64: string, nonceB64: string, roomId: string) => Uint8Array | null;
  setRoomKey: (roomId: string, key: Uint8Array) => Promise<void>;
  getRoomKey: (roomId: string) => Uint8Array | null;
  generateRoomKey: (roomId: string) => Promise<Uint8Array>;
  loadRoomKey: (roomId: string) => Promise<void>;
  roomKeyPersistenceFailures: ReadonlyMap<string, RoomKeyPersistenceFailure>;
  retryRoomKeyPersistence: (roomId: string) => Promise<boolean>;
}

export interface RoomKeyPersistenceFailure {
  roomId: string;
  message: string;
}

export class RoomKeyPersistenceError extends Error {
  readonly roomId: string;
  readonly reason: "storage_unavailable" | "identity_changed";

  constructor(
    roomId: string,
    reason: "storage_unavailable" | "identity_changed" = "storage_unavailable",
  ) {
    super(
      reason === "identity_changed"
        ? "The active account changed while the room encryption key was being saved."
        : "This device could not save the room encryption key.",
    );
    this.name = "RoomKeyPersistenceError";
    this.roomId = roomId;
    this.reason = reason;
  }
}

const CryptoContext = createContext<CryptoContextValue | null>(null);

export function CryptoProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, userId } = useAuth();
  const [keypair, setKeypair] = useState<{
    userId: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [roomKeyPersistenceFailures, setRoomKeyPersistenceFailures] = useState<
    Map<string, RoomKeyPersistenceFailure>
  >(new Map());
  const roomKeys = useRef(new Map<string, Uint8Array>()).current;
  const roomKeyOwnerRef = useRef<string | null>(null);
  const identityRef = useRef<{ userId: string | null; generation: number }>({
    userId: null,
    generation: 0,
  });

  useLayoutEffect(() => {
    identityRef.current = {
      userId: isSignedIn && userId ? userId : null,
      generation: identityRef.current.generation + 1,
    };
    roomKeys.clear();
    roomKeyOwnerRef.current = null;
  }, [isSignedIn, roomKeys, userId]);

  useEffect(() => {
    const generation = identityRef.current.generation;
    let cancelled = false;
    roomKeys.clear();
    roomKeyOwnerRef.current = null;
    setKeypair(null);
    setIsReady(false);
    setRoomKeyPersistenceFailures(new Map());

    if (!isSignedIn || !userId) {
      setIsReady(true);
      return () => {
        cancelled = true;
      };
    }

    roomKeyOwnerRef.current = userId;
    void (async () => {
      try {
        const saved = await getStored(deviceKeypairStorageKey(userId));
        const secretKey = saved ? decodeBase64(JSON.parse(saved).secretKey) : null;
        const pair = secretKey?.length === nacl.box.secretKeyLength
          ? nacl.box.keyPair.fromSecretKey(secretKey)
          : nacl.box.keyPair();
        if (!saved) {
          await setStored(
            deviceKeypairStorageKey(userId),
            JSON.stringify({ secretKey: encodeBase64(pair.secretKey) }),
          );
        }
        if (
          !cancelled &&
          identityRef.current.userId === userId &&
          identityRef.current.generation === generation
        ) {
          setKeypair({ userId, ...pair });
        }
      } catch {
        const pair = nacl.box.keyPair();
        if (
          !cancelled &&
          identityRef.current.userId === userId &&
          identityRef.current.generation === generation
        ) {
          setKeypair({ userId, ...pair });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, roomKeys, userId]);

  // This is intentionally an independent partial profile update: it must not
  // race with the display-name/avatar controls.
  useEffect(() => {
    if (!keypair || !userId || keypair.userId !== userId) return;
    const generation = identityRef.current.generation;
    let cancelled = false;
    void (async () => {
      if (!isSignedIn || typeof getToken !== "function") {
        setIsReady(true);
        return;
      }

      let attempt = 0;
      let warned = false;
      while (!cancelled) {
        try {
          const token = await getToken();
          if (
            cancelled ||
            identityRef.current.userId !== userId ||
            identityRef.current.generation !== generation ||
            keypair.userId !== userId
          ) {
            return;
          }
          const domain = process.env["EXPO_PUBLIC_DOMAIN"];
          const profileUrl = `${domain ? `https://${domain}` : "http://localhost:5000"}/api/profile`;
          const response = await fetch(profileUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              publicKey: encodeBase64(keypair.publicKey),
            }),
          });
          if (
            cancelled ||
            identityRef.current.userId !== userId ||
            identityRef.current.generation !== generation ||
            keypair.userId !== userId
          ) {
            return;
          }
          if (response.ok) {
            setIsReady(true);
            return;
          }

          if (
            !warned &&
            attempt >= PUBLIC_KEY_SYNC_RETRY_DELAYS_MS.length - 1
          ) {
            warned = true;
            console.warn(
              `Public key sync failed (${response.status}); encrypted rooms will retry before joining.`,
            );
          }
        } catch (error) {
          if (
            !warned &&
            attempt >= PUBLIC_KEY_SYNC_RETRY_DELAYS_MS.length - 1
          ) {
            warned = true;
            console.warn(
              "Public key sync is temporarily unavailable; encrypted rooms will retry before joining.",
              error,
            );
          }
        }

        const retryDelay =
          PUBLIC_KEY_SYNC_RETRY_DELAYS_MS[
            Math.min(attempt, PUBLIC_KEY_SYNC_RETRY_DELAYS_MS.length - 1)
          ];
        attempt += 1;
        await waitForRetry(retryDelay);
        if (
          identityRef.current.userId !== userId ||
          identityRef.current.generation !== generation
        ) {
          return;
        }
      }
      if (!cancelled) {
        if (!warned) {
          console.warn(
            "Public key sync stopped before encrypted rooms became available.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, isSignedIn, keypair, userId]);

  const persistRoomKey = useCallback(async (
    roomId: string,
    key: Uint8Array,
  ): Promise<"saved" | "storage_unavailable" | "identity_changed"> => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) {
      throw new Error("An authenticated account is required to store room keys.");
    }
    const generation = identityRef.current.generation;
    try {
      await setStored(roomStorageKey(userId, roomId), encodeBase64(key));
      if (
        identityRef.current.userId !== userId ||
        identityRef.current.generation !== generation ||
        roomKeyOwnerRef.current !== userId
      ) {
        return "identity_changed";
      }
      setRoomKeyPersistenceFailures((current) => {
        if (!current.has(roomId)) return current;
        const next = new Map(current);
        next.delete(roomId);
        return next;
      });
      return "saved";
    } catch {
      if (
        identityRef.current.userId === userId &&
        identityRef.current.generation === generation
      ) {
        setRoomKeyPersistenceFailures((current) => {
          const next = new Map(current);
          next.set(roomId, {
            roomId,
            message:
              "Keep this room open, make secure storage available, and retry before continuing.",
          });
          return next;
        });
      }
      return "storage_unavailable";
    }
  }, [userId]);
  const setRoomKey = useCallback(async (roomId: string, key: Uint8Array) => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) {
      throw new Error("An authenticated account is required to store room keys.");
    }
    roomKeys.set(roomId, key);
    const persistenceResult = await persistRoomKey(roomId, key);
    if (persistenceResult !== "saved") {
      throw new RoomKeyPersistenceError(roomId, persistenceResult);
    }
  }, [persistRoomKey, roomKeys, userId]);
  const retryRoomKeyPersistence = useCallback(async (roomId: string) => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) {
      return false;
    }
    const key = roomKeys.get(roomId);
    return key ? (await persistRoomKey(roomId, key)) === "saved" : false;
  }, [persistRoomKey, roomKeys, userId]);
  const getRoomKey = useCallback(
    (roomId: string) =>
      userId && roomKeyOwnerRef.current === userId
        ? roomKeys.get(roomId) ?? null
        : null,
    [roomKeys, userId],
  );
  const loadRoomKey = useCallback(async (roomId: string) => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) return;
    if (roomKeys.has(roomId)) return;
    const generation = identityRef.current.generation;
    const saved = await getStored(roomStorageKey(userId, roomId));
    if (
      saved &&
      identityRef.current.userId === userId &&
      identityRef.current.generation === generation &&
      roomKeyOwnerRef.current === userId
    ) {
      roomKeys.set(roomId, decodeBase64(saved));
    }
  }, [roomKeys, userId]);
  const generateRoomKey = useCallback(async (roomId: string) => {
    const key = nacl.randomBytes(nacl.secretbox.keyLength);
    await setRoomKey(roomId, key);
    return key;
  }, [setRoomKey]);
  const encryptBytes = useCallback((data: Uint8Array, roomId: string) => {
    const key = getRoomKey(roomId); if (!key) return null;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    return { ciphertextB64: encodeBase64(nacl.secretbox(data, nonce, key)), nonceB64: encodeBase64(nonce) };
  }, [getRoomKey]);
  const decryptBytes = useCallback((ciphertextB64: string, nonceB64: string, roomId: string) => {
    const key = getRoomKey(roomId); if (!key) return null;
    try { return nacl.secretbox.open(decodeBase64(ciphertextB64), decodeBase64(nonceB64), key) ?? null; } catch { return null; }
  }, [getRoomKey]);
  const encryptMessage = useCallback((plaintext: string, roomId: string) => encryptBytes(decodeUTF8(plaintext), roomId), [encryptBytes]);
  const decryptMessage = useCallback((ciphertextB64: string, nonceB64: string, roomId: string) => {
    const result = decryptBytes(ciphertextB64, nonceB64, roomId);
    return result ? new TextDecoder().decode(result) : null;
  }, [decryptBytes]);
  const encryptRoomKey = useCallback((roomKey: Uint8Array, recipient: string) => {
    if (!keypair || keypair.userId !== userId) return null;
    try { const nonce = nacl.randomBytes(nacl.box.nonceLength); return { ciphertextB64: encodeBase64(nacl.box(roomKey, nonce, decodeBase64(recipient), keypair.secretKey)), nonceB64: encodeBase64(nonce) }; } catch { return null; }
  }, [keypair, userId]);
  const decryptRoomKeyEnvelope = useCallback((ciphertext: string, nonce: string, sender: string) => {
    if (!keypair || keypair.userId !== userId) return null;
    try { return nacl.box.open(decodeBase64(ciphertext), decodeBase64(nonce), decodeBase64(sender), keypair.secretKey) ?? null; } catch { return null; }
  }, [keypair, userId]);

  const activeKeypair = keypair?.userId === userId ? keypair : null;
  const activeRoomKeys =
    roomKeyOwnerRef.current === userId ? roomKeys : new Map<string, Uint8Array>();

  return <CryptoContext.Provider value={{ publicKeyB64: activeKeypair ? encodeBase64(activeKeypair.publicKey) : "", isReady, roomKeys: activeRoomKeys, decryptRoomKeyEnvelope, encryptRoomKey, encryptMessage, decryptMessage, encryptBytes, decryptBytes, setRoomKey, getRoomKey, generateRoomKey, loadRoomKey, roomKeyPersistenceFailures, retryRoomKeyPersistence }}>{children}</CryptoContext.Provider>;
}

export function useCrypto(): CryptoContextValue {
  const value = useContext(CryptoContext);
  if (!value) throw new Error("useCrypto must be used inside CryptoProvider");
  return value;
}
