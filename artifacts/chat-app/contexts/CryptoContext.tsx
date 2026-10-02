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
export const DEVICE_KEY_REGISTRATION_SLOW_MS = 25_000;
// A reset takes over the account's registration with compare-and-set writes.
// Each attempt re-reads the key the server holds; after this many losses to
// concurrent takeovers the device reports itself superseded instead.
const MAX_TAKEOVER_ATTEMPTS = 3;
const ROOM_KEY_SAVE_FAILURE_MESSAGE =
  "Keep this room open, make secure storage available, and retry before continuing.";
const ROOM_KEY_LOAD_FAILURE_MESSAGE =
  "This device could not read its saved encryption keys. Make secure storage available, then retry.";

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nextRegistrationVersion(previous: number | null): number {
  return (previous ?? 0) + 1;
}

function profileApiUrl(): string {
  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  return `${domain ? `https://${domain}` : "http://localhost:5000"}/api/profile`;
}

// Only a secretbox-sized key may ever be installed, saved, or enveloped: any
// other length would make every later encryption throw ("bad key size") and
// could spread an unusable key to other members.
function isRoomKey(candidate: Uint8Array): boolean {
  return candidate.length === nacl.secretbox.keyLength;
}

// Native secure storage rejects the ":" separators used in the logical keys
// above, so they are encoded (see lib/secureStorageKey.ts). Web keeps the
// logical key in localStorage, deliberately: the device identity has to
// survive a page reload. Session-only web keys were tried (to clear a
// cleartext browser-storage scan finding) and made every refresh register a
// brand-new key, which forced a reset that superseded the account's other
// devices and orphaned the envelopes sent to the discarded key. That finding
// is an accepted risk; do not move these keys back into memory.
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

/**
 * Server-side registration state of the device public key.
 * - `unavailable`: no device key for the signed-in account yet (loading or signed out)
 * - `registering`: the current key is being sent to the server
 * - `retrying`: at least one registration attempt failed; retries continue automatically
 * - `registered`: the server confirmed the current key; encrypted rooms may be joined
 * - `superseded`: the server holds a different key for this account (registered by
 *   another device or session); only an explicit reset here can take over
 */
export type DeviceKeyRegistrationStatus =
  | "unavailable"
  | "registering"
  | "retrying"
  | "registered"
  | "superseded";
/**
 * How the current keypair is (re)registered with the server.
 * - `confirm`: register only if the account has no key yet or already this one.
 *   The server refuses to replace a different key, so a stale device or session
 *   can never displace a newer registration by accident.
 * - `takeover`: an explicit reset; replaces whatever key the server holds using
 *   compare-and-set writes against the key that was just read back.
 */
type RegistrationMode = "confirm" | "takeover";
export interface CryptoContextValue {
  publicKeyB64: string;
  isReady: boolean;
  deviceKeyStatus: DeviceKeyRegistrationStatus;
  /**
   * True when the current registration loop has remained unsettled long
   * enough to warrant user guidance. This is informational only: it never
   * settles, cancels, or bypasses an in-flight registration request.
   */
  isDeviceKeyRegistrationSlow: boolean;
  /**
   * Present while `deviceKeyStatus` is `superseded`: the key the server holds
   * for this account instead of this device's key, when the server said which.
   */
  deviceKeyConflict: { registeredPublicKeyB64: string | null } | null;
  /**
   * Replaces this device's encryption keypair for the signed-in account. The
   * new secret key is written to secure storage before the in-memory identity
   * changes, encrypted-room joins stay blocked until the server confirms the
   * new public key, and room keys already saved on this device are kept.
   */
  resetDeviceIdentity: () => Promise<DeviceIdentityResetResult>;
  /**
   * Records that the server authoritatively reported a different registered
   * key for this account (for example in a room roster). Encrypted rooms close
   * until the user resets the device key here.
   */
  markDeviceKeySuperseded: (registeredPublicKeyB64: string | null) => void;
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
  /**
   * "save": an in-memory room key could not be written to secure storage.
   * "load": secure storage could not be read, so a previously saved key may be
   * unavailable. Absent means "save" for callers created before this field.
   */
  kind?: "save" | "load";
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
  const getTokenRef = useRef(getToken);
  const [keypair, setKeypair] = useState<{
    userId: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    registrationVersion: number;
    registration: RegistrationMode;
  } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [registrationRetrying, setRegistrationRetrying] = useState(false);
  const [isDeviceKeyRegistrationSlow, setIsDeviceKeyRegistrationSlow] = useState(false);
  const [registrationConflict, setRegistrationConflict] = useState<{
    userId: string;
    registeredPublicKeyB64: string | null;
  } | null>(null);
  const [roomKeyPersistenceFailures, setRoomKeyPersistenceFailures] = useState<
    Map<string, RoomKeyPersistenceFailure>
  >(new Map());
  const roomKeys = useRef(new Map<string, Uint8Array>()).current;
  const roomKeyOwnerRef = useRef<string | null>(null);
  const identityRef = useRef<{ userId: string | null; generation: number }>({
    userId: null,
    generation: 0,
  });
  // Public-key registration requests that have not settled yet. A replacement
  // key is sent only after every earlier request for the same account settled,
  // so a slow write can never leave the server holding a key this device
  // already replaced.
  const pendingRegistrationsRef = useRef<
    Array<{ userId: string; settled: Promise<void> }>
  >([]);
  // The key the server most recently confirmed for the signed-in account.
  const confirmedPublicKeyRef = useRef<{
    userId: string;
    publicKeyB64: string;
  } | null>(null);
  const resetInFlightRef = useRef(false);

  useLayoutEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

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
    setRegistrationRetrying(false);
    setIsDeviceKeyRegistrationSlow(false);
    setRegistrationConflict(null);
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
        const savedIdentity = saved ? JSON.parse(saved) as {
          secretKey?: string;
          registrationVersion?: number;
        } : null;
        const secretKey = savedIdentity?.secretKey
          ? decodeBase64(savedIdentity.secretKey)
          : null;
        const registrationVersion =
          typeof savedIdentity?.registrationVersion === "number" &&
          Number.isSafeInteger(savedIdentity.registrationVersion) &&
          savedIdentity.registrationVersion >= 0
            ? savedIdentity.registrationVersion
            : null;
        const pair = secretKey?.length === nacl.box.secretKeyLength
          ? nacl.box.keyPair.fromSecretKey(secretKey)
          : nacl.box.keyPair();
        const persistedVersion =
          registrationVersion ?? nextRegistrationVersion(null);
        if (!saved || registrationVersion === null) {
          await setStored(
            deviceKeypairStorageKey(userId),
            JSON.stringify({
              secretKey: encodeBase64(pair.secretKey),
              registrationVersion: persistedVersion,
            }),
          );
        }
        if (
          !cancelled &&
          identityRef.current.userId === userId &&
          identityRef.current.generation === generation
        ) {
          setKeypair({
            userId,
            ...pair,
            registrationVersion: persistedVersion,
            registration: "confirm",
          });
        }
      } catch (error) {
        const pair = nacl.box.keyPair();
        if (
          !cancelled &&
          identityRef.current.userId === userId &&
          identityRef.current.generation === generation
        ) {
          // Keep the real cause visible: a deterministic failure here (for
          // example a storage key name the keychain rejects) would otherwise
          // look like "secure storage unavailable" while the device silently
          // runs on a fresh in-memory identity after every launch. Stale
          // generations (sign-out or account switch mid-load) stay quiet.
          console.warn(
            "Device encryption identity could not be loaded from or saved to secure storage",
            error instanceof Error ? error.message : error,
          );
          setKeypair({
            userId,
            ...pair,
            registrationVersion: nextRegistrationVersion(null),
            registration: "confirm",
          });
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
    setIsDeviceKeyRegistrationSlow(false);
    const slowWarningTimer = setTimeout(() => {
      if (
        !cancelled &&
        identityRef.current.userId === userId &&
        identityRef.current.generation === generation
      ) {
        setIsDeviceKeyRegistrationSlow(true);
      }
    }, DEVICE_KEY_REGISTRATION_SLOW_MS);
    const clearSlowWarning = () => {
      clearTimeout(slowWarningTimer);
      setIsDeviceKeyRegistrationSlow(false);
    };
    void (async () => {
      if (!isSignedIn || typeof getTokenRef.current !== "function") {
        setIsReady(true);
        return;
      }

      let attempt = 0;
      let takeoverAttempts = 0;
      let warned = false;
      let requestRegistrationVersion = keypair.registrationVersion;
      const identityChanged = () =>
        cancelled ||
        identityRef.current.userId !== userId ||
        identityRef.current.generation !== generation ||
        keypair.userId !== userId;
      const publicKeyB64 = encodeBase64(keypair.publicKey);
      const profileUrl = profileApiUrl();
      const confirmRegistration = () => {
        confirmedPublicKeyRef.current = { userId, publicKeyB64 };
        setRegistrationConflict(null);
        setRegistrationRetrying(false);
        clearSlowWarning();
        setIsReady(true);
      };
      while (!cancelled) {
        try {
          const token = await getTokenRef.current();
          if (identityChanged()) return;
          // Earlier registrations (for example the key this one replaces) may
          // still be in flight. Wait for them to settle, however long that
          // takes: sending early could let a slow old write land last.
          const earlierRequests = pendingRegistrationsRef.current.filter(
            (entry) => entry.userId === userId,
          );
          if (earlierRequests.length > 0) {
            await Promise.all(earlierRequests.map((entry) => entry.settled));
            if (identityChanged()) return;
          }
          // A takeover asserts the key it replaces, so the server can refuse
          // it when someone else registered in between. A plain confirmation
          // never replaces a different key.
          let previousPublicKey: string | null | undefined;
          if (keypair.registration === "takeover") {
            const serverRecord = await readRegisteredPublicKeyRecord(profileUrl, token);
            if (identityChanged()) return;
            previousPublicKey = serverRecord.publicKey;
            requestRegistrationVersion = nextRegistrationVersion(
              serverRecord.registrationVersion,
            );
            await persistRegistrationVersion(
              userId,
              keypair.secretKey,
              requestRegistrationVersion,
            );
            if (previousPublicKey === publicKeyB64) {
              confirmRegistration();
              return;
            }
          }
          const request = fetch(profileUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              previousPublicKey === undefined
                ? {
                    publicKey: publicKeyB64,
                    registrationVersion: requestRegistrationVersion,
                  }
                : {
                    publicKey: publicKeyB64,
                    previousPublicKey,
                    registrationVersion: requestRegistrationVersion,
                  },
            ),
          });
          const tracked = {
            userId,
            settled: request.then(
              () => undefined,
              () => undefined,
            ),
          };
          pendingRegistrationsRef.current = [...pendingRegistrationsRef.current, tracked];
          void tracked.settled.then(() => {
            pendingRegistrationsRef.current = pendingRegistrationsRef.current.filter(
              (entry) => entry !== tracked,
            );
          });
          const response = await request;
          if (identityChanged()) return;
          if (response.ok) {
            // The server applied this exact write, so it holds this key now;
            // any later write that does not assert it is refused server-side.
            confirmRegistration();
            return;
          }
          if (response.status === 409) {
            // The account is registered under a different key. Re-read and
            // retry only for an explicit takeover; a plain confirmation must
            // never displace another device's registration.
            const conflict = await readConflictingPublicKey(response);
            if (identityChanged()) return;
            if (
              conflict.code === "PUBLIC_KEY_STALE" ||
              conflict.code === "PUBLIC_KEY_VERSION_AHEAD"
            ) {
              // A version response is not proof that this device is
              // registered. Read the authoritative key and revision before
              // deciding whether rooms can reopen or retrying a takeover.
              const serverRecord = await readRegisteredPublicKeyRecord(
                profileUrl,
                token,
              );
              if (identityChanged()) return;
              const registeredPublicKeyB64 = serverRecord.publicKey;
              if (
                keypair.registration === "takeover" &&
                registeredPublicKeyB64 !== publicKeyB64 &&
                takeoverAttempts < MAX_TAKEOVER_ATTEMPTS - 1
              ) {
                takeoverAttempts += 1;
                requestRegistrationVersion = nextRegistrationVersion(
                  serverRecord.registrationVersion,
                );
                await persistRegistrationVersion(
                  userId,
                  keypair.secretKey,
                  requestRegistrationVersion,
                );
                continue;
              }
              if (registeredPublicKeyB64 === publicKeyB64) {
                await persistRegistrationVersion(
                  userId,
                  keypair.secretKey,
                  serverRecord.registrationVersion ??
                    requestRegistrationVersion,
                );
                confirmRegistration();
                return;
              }
              confirmedPublicKeyRef.current = null;
              setRegistrationRetrying(false);
              setIsReady(false);
              setRegistrationConflict({ userId, registeredPublicKeyB64 });
              return;
            }
            const registeredPublicKeyB64 = conflict.publicKey;
            if (
              keypair.registration === "takeover" &&
              takeoverAttempts < MAX_TAKEOVER_ATTEMPTS - 1
            ) {
              takeoverAttempts += 1;
              continue;
            }
            confirmedPublicKeyRef.current = null;
            setRegistrationRetrying(false);
            clearSlowWarning();
            setIsReady(false);
            setRegistrationConflict({ userId, registeredPublicKeyB64 });
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

        if (
          !cancelled &&
          identityRef.current.userId === userId &&
          identityRef.current.generation === generation
        ) {
          setRegistrationRetrying(true);
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
      clearTimeout(slowWarningTimer);
    };
  }, [isSignedIn, keypair, userId]);

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
    } catch (error) {
      // The retry UX below is the same for every cause; the log is what makes
      // a deterministic failure (rejected key name, corrupt keychain entry)
      // distinguishable from storage that is genuinely unavailable.
      console.warn(
        "Room encryption key could not be saved to secure storage",
        error instanceof Error ? error.message : error,
      );
      if (
        identityRef.current.userId === userId &&
        identityRef.current.generation === generation
      ) {
        setRoomKeyPersistenceFailures((current) => {
          const next = new Map(current);
          next.set(roomId, {
            roomId,
            kind: "save",
            message: ROOM_KEY_SAVE_FAILURE_MESSAGE,
          });
          return next;
        });
      }
      return "storage_unavailable";
    }
  }, [userId]);
  // Reads a saved room key into memory. Never rejects: a secure-storage read
  // failure is reported through roomKeyPersistenceFailures so screens can show
  // a retry instead of waiting forever on a promise that will not settle.
  const readSavedRoomKey = useCallback(async (
    roomId: string,
  ): Promise<"loaded" | "missing" | "storage_unavailable" | "skipped"> => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) return "skipped";
    if (roomKeys.has(roomId)) return "loaded";
    const generation = identityRef.current.generation;
    const identityUnchanged = () =>
      identityRef.current.userId === userId &&
      identityRef.current.generation === generation &&
      roomKeyOwnerRef.current === userId;
    const clearLoadFailure = () => {
      setRoomKeyPersistenceFailures((current) => {
        if (current.get(roomId)?.kind !== "load") return current;
        const next = new Map(current);
        next.delete(roomId);
        return next;
      });
    };
    let saved: string | null;
    try {
      saved = await getStored(roomStorageKey(userId, roomId));
    } catch (error) {
      console.warn(
        "Saved room key could not be read from secure storage",
        error instanceof Error ? error.message : error,
      );
      if (identityUnchanged()) {
        setRoomKeyPersistenceFailures((current) => {
          const next = new Map(current);
          next.set(roomId, {
            roomId,
            kind: "load",
            message: ROOM_KEY_LOAD_FAILURE_MESSAGE,
          });
          return next;
        });
      }
      return "storage_unavailable";
    }
    if (!identityUnchanged()) return "skipped";
    if (!saved) {
      clearLoadFailure();
      return "missing";
    }
    let key: Uint8Array | null;
    try {
      key = decodeBase64(saved);
    } catch {
      key = null;
    }
    if (!key || !isRoomKey(key)) {
      // A corrupted entry (undecodable or not a secretbox-sized key) is treated
      // as absent so the room can still receive the key again from another
      // member; retrying the read cannot fix it, and installing it would make
      // every later encryption fail.
      console.warn("Saved room key is unreadable and will be ignored.");
      clearLoadFailure();
      return "missing";
    }
    roomKeys.set(roomId, key);
    clearLoadFailure();
    return "loaded";
  }, [roomKeys, userId]);
  const setRoomKey = useCallback(async (roomId: string, key: Uint8Array) => {
    if (
      !userId ||
      roomKeyOwnerRef.current !== userId ||
      identityRef.current.userId !== userId
    ) {
      throw new Error("An authenticated account is required to store room keys.");
    }
    if (!isRoomKey(key)) {
      throw new Error(
        `Room keys must be exactly ${nacl.secretbox.keyLength} bytes.`,
      );
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
    if (key) return (await persistRoomKey(roomId, key)) === "saved";
    // Nothing is in memory, so the outstanding failure is a read failure:
    // retry the read instead of reporting an impossible save.
    const result = await readSavedRoomKey(roomId);
    return result === "loaded" || result === "missing";
  }, [persistRoomKey, readSavedRoomKey, roomKeys, userId]);
  const getRoomKey = useCallback(
    (roomId: string) =>
      userId && roomKeyOwnerRef.current === userId
        ? roomKeys.get(roomId) ?? null
        : null,
    [roomKeys, userId],
  );
  const loadRoomKey = useCallback(async (roomId: string) => {
    await readSavedRoomKey(roomId);
  }, [readSavedRoomKey]);
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
    if (!keypair || keypair.userId !== userId || !isRoomKey(roomKey)) return null;
    try { const nonce = nacl.randomBytes(nacl.box.nonceLength); return { ciphertextB64: encodeBase64(nacl.box(roomKey, nonce, decodeBase64(recipient), keypair.secretKey)), nonceB64: encodeBase64(nonce) }; } catch { return null; }
  }, [keypair, userId]);
  const decryptRoomKeyEnvelope = useCallback((ciphertext: string, nonce: string, sender: string) => {
    if (!keypair || keypair.userId !== userId) return null;
    try {
      const opened = nacl.box.open(decodeBase64(ciphertext), decodeBase64(nonce), decodeBase64(sender), keypair.secretKey);
      // An authentic envelope that does not carry a secretbox-sized key is
      // still unusable; refuse it rather than install a key that cannot encrypt.
      return opened && isRoomKey(opened) ? opened : null;
    } catch { return null; }
  }, [keypair, userId]);

  const activeKeypair = keypair?.userId === userId ? keypair : null;
  const activeRoomKeys =
    roomKeyOwnerRef.current === userId ? roomKeys : new Map<string, Uint8Array>();
  const activeConflict =
    activeKeypair && registrationConflict?.userId === userId ? registrationConflict : null;
  const deviceKeyStatus: DeviceKeyRegistrationStatus = !activeKeypair
    ? "unavailable"
    : isReady
      ? "registered"
      : activeConflict
        ? "superseded"
        : registrationRetrying
          ? "retrying"
          : "registering";
  const deviceKeyConflict = activeConflict
    ? { registeredPublicKeyB64: activeConflict.registeredPublicKeyB64 }
    : null;

  const markDeviceKeySuperseded = useCallback(
    (registeredPublicKeyB64: string | null) => {
      if (!isSignedIn || !userId || identityRef.current.userId !== userId) return;
      // A report of this device's own key is agreement, not a conflict.
      const ownPublicKeyB64 =
        keypair?.userId === userId ? encodeBase64(keypair.publicKey) : null;
      if (registeredPublicKeyB64 && registeredPublicKeyB64 === ownPublicKeyB64) return;
      confirmedPublicKeyRef.current = null;
      setRegistrationRetrying(false);
      setIsDeviceKeyRegistrationSlow(false);
      setIsReady(false);
      setRegistrationConflict({ userId, registeredPublicKeyB64 });
    },
    [isSignedIn, keypair, userId],
  );

  const resetDeviceIdentity = useCallback(async (): Promise<DeviceIdentityResetResult> => {
    if (!isSignedIn || !userId || identityRef.current.userId !== userId) {
      return { status: "unauthenticated" };
    }
    // Refuse while the current key is still loading or registering so two
    // registrations for different keys never race, and refuse re-entrant
    // calls so secure storage and the in-memory identity cannot diverge. A
    // superseded key is idle, so taking over from it is allowed.
    const superseded = registrationConflict?.userId === userId;
    if (
      !keypair ||
      keypair.userId !== userId ||
      (!isReady && !superseded) ||
      resetInFlightRef.current
    ) {
      return { status: "not_ready" };
    }
    resetInFlightRef.current = true;
    try {
      const generation = identityRef.current.generation;
      const pair = nacl.box.keyPair();
      const registrationVersion = nextRegistrationVersion(
        keypair.registrationVersion,
      );
      try {
        // Persist first: if the write fails the device keeps its current
        // identity, which the server still knows about.
        await setStored(
          deviceKeypairStorageKey(userId),
          JSON.stringify({
            secretKey: encodeBase64(pair.secretKey),
            registrationVersion,
          }),
        );
      } catch (error) {
        console.warn(
          "Replacement device encryption identity could not be saved to secure storage",
          error instanceof Error ? error.message : error,
        );
        return { status: "storage_unavailable" };
      }
      if (
        identityRef.current.userId !== userId ||
        identityRef.current.generation !== generation
      ) {
        // Another account took over mid-write. The stored key belongs to the
        // original account and registers the next time it signs in.
        return { status: "identity_changed" };
      }
      // Leave encrypted rooms until the server confirms the replacement key.
      setIsReady(false);
      setRegistrationRetrying(false);
      setIsDeviceKeyRegistrationSlow(false);
      setRegistrationConflict(null);
      setKeypair({
        userId,
        ...pair,
        registrationVersion,
        registration: "takeover",
      });
      return { status: "reset", publicKeyB64: encodeBase64(pair.publicKey) };
    } finally {
      resetInFlightRef.current = false;
    }
  }, [isReady, isSignedIn, keypair, registrationConflict, userId]);

  return <CryptoContext.Provider value={{ publicKeyB64: activeKeypair ? encodeBase64(activeKeypair.publicKey) : "", isReady, deviceKeyStatus, isDeviceKeyRegistrationSlow, deviceKeyConflict, resetDeviceIdentity, markDeviceKeySuperseded, roomKeys: activeRoomKeys, decryptRoomKeyEnvelope, encryptRoomKey, encryptMessage, decryptMessage, encryptBytes, decryptBytes, setRoomKey, getRoomKey, generateRoomKey, loadRoomKey, roomKeyPersistenceFailures, retryRoomKeyPersistence }}>{children}</CryptoContext.Provider>;
}

export function useCrypto(): CryptoContextValue {
  const value = useContext(CryptoContext);
  if (!value) throw new Error("useCrypto must be used inside CryptoProvider");
  return value;
}

// The key and authoritative revision the server currently holds for the
// signed-in account. Older servers may omit registrationVersion.
async function readRegisteredPublicKeyRecord(
  profileUrl: string,
  token: string | null,
): Promise<{ publicKey: string | null; registrationVersion: number | null }> {
  const response = await fetch(profileUrl, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token ?? ""}`,
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`Public key lookup failed (${response.status})`);
  }
  const body = await response.json();
  const registrationVersion =
    body &&
    typeof body === "object" &&
    typeof (body as { registrationVersion?: unknown }).registrationVersion ===
      "number" &&
    Number.isSafeInteger(
      (body as { registrationVersion: number }).registrationVersion,
    ) &&
    (body as { registrationVersion: number }).registrationVersion >= 0
      ? (body as { registrationVersion: number }).registrationVersion
      : null;
  return { publicKey: publicKeyFromBody(body), registrationVersion };
}

async function persistRegistrationVersion(
  userId: string,
  secretKey: Uint8Array,
  registrationVersion: number,
): Promise<void> {
  await setStored(
    deviceKeypairStorageKey(userId),
    JSON.stringify({ secretKey: encodeBase64(secretKey), registrationVersion }),
  );
}

// A 409 body names the key the server kept; older servers may omit it.
async function readConflictingPublicKey(response: Response): Promise<{
  code: string | null;
  publicKey: string | null;
}> {
  try {
    const body = await response.json();
    return {
      code:
        body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
          ? (body as { code: string }).code
          : null,
      publicKey: publicKeyFromBody(body),
    };
  } catch {
    return { code: null, publicKey: null };
  }
}

function publicKeyFromBody(body: unknown): string | null {
  const publicKey =
    body && typeof body === "object"
      ? (body as { publicKey?: unknown }).publicKey
      : undefined;
  return typeof publicKey === "string" ? publicKey : null;
}

export type DeviceIdentityResetResult =
  | { status: "reset"; publicKeyB64: string }
  | { status: "unauthenticated" }
  | { status: "not_ready" }
  | { status: "storage_unavailable" }
  | { status: "identity_changed" };
