import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import * as nacl from "tweetnacl";
import {
  decodeBase64,
  encodeBase64,
} from "tweetnacl-util";
import {
  CryptoProvider,
  type CryptoContextValue,
  useCrypto,
} from "../contexts/CryptoContext";
import { toSecureStoreKey } from "../lib/secureStorageKey";
import { SECURE_STORE_KEY_PATTERN } from "../test-utils/secureStoreKeyRule";

const mockSecureStore = new Map<string, string>();
let mockRandomCounter = 0;
let mockRoomKeyWriteFailure = false;
let mockRoomKeyReadFailure = false;
let mockDeviceKeyWriteFailure = false;
let mockRoomKeyWriteRelease: (() => void) | null = null;
let mockAuthUserId: string | null = "crypto-test-user";
let mockGetToken: (() => Promise<string | null>) | null = null;

// Storage keys as the native keychain/keystore receives them.
// Prefixed with "mock" so the hoisted jest.mock factory below may reference it.
const mockRoomKeyStoragePrefix = toSecureStoreKey("devstudio_roomkey:");
const mockDeviceKeyStoragePrefix = toSecureStoreKey("devstudio_device_keypair_v1:");
const roomKeyStorageKey = (userId: string, roomId: string) =>
  toSecureStoreKey(`devstudio_roomkey:${userId}:${roomId}`);
const deviceKeypairStorageKey = (userId: string) =>
  toSecureStoreKey(`devstudio_device_keypair_v1:${userId}`);
// Message of the native write failure simulated for the device identity.
const mockDeviceKeyWriteError = "Keychain write failed (errSecInteractionNotAllowed)";

jest.mock("expo-secure-store", () => {
  // Same validation as the real module on iOS and Android: the keychain and
  // keystore reject any other key name, which is exactly what broke room key
  // persistence on phones while web (localStorage) kept working.
  const { ensureValidSecureStoreKey: ensureValidKey } = jest.requireActual(
    "../test-utils/secureStoreKeyRule",
  ) as typeof import("../test-utils/secureStoreKeyRule");
  return {
    getItemAsync: jest.fn(async (key: string) => {
      ensureValidKey(key);
      if (mockRoomKeyReadFailure && key.startsWith(mockRoomKeyStoragePrefix)) {
        throw new Error("Could not read the item in SecureStore");
      }
      return mockSecureStore.get(key) ?? null;
    }),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      ensureValidKey(key);
      if (mockDeviceKeyWriteFailure && key.startsWith(mockDeviceKeyStoragePrefix)) {
        throw new Error(mockDeviceKeyWriteError);
      }
      if (key.startsWith(mockRoomKeyStoragePrefix) && mockRoomKeyWriteRelease) {
        await new Promise<void>((resolve) => {
          const release = mockRoomKeyWriteRelease;
          mockRoomKeyWriteRelease = () => {
            release?.();
            resolve();
          };
        });
      }
      if (mockRoomKeyWriteFailure && key.startsWith(mockRoomKeyStoragePrefix)) {
        throw new Error("Secure storage unavailable");
      }
      mockSecureStore.set(key, value);
    }),
  };
});

jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn((length: number) => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (mockRandomCounter + index) % 256;
    }
    mockRandomCounter += length;
    return bytes;
  }),
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({
    getToken: mockGetToken,
    isSignedIn: mockAuthUserId !== null,
    userId: mockAuthUserId,
  }),
}));

let cryptoValue: CryptoContextValue | null = null;

function CryptoProbe() {
  cryptoValue = useCrypto();
  return null;
}

async function renderCryptoProvider() {
  const view = render(
    <CryptoProvider>
      <CryptoProbe />
    </CryptoProvider>,
  );

  await waitFor(() => {
    expect(cryptoValue?.isReady).toBe(true);
  });

  return view;
}

describe("CryptoProvider", () => {
  beforeEach(() => {
    mockSecureStore.clear();
    globalThis.localStorage?.clear();
    mockRandomCounter = 0;
    mockRoomKeyWriteFailure = false;
    mockRoomKeyReadFailure = false;
    mockDeviceKeyWriteFailure = false;
    mockRoomKeyWriteRelease = null;
    mockAuthUserId = "crypto-test-user";
    mockGetToken = null;
    cryptoValue = null;
  });

  it("retries a transient public-key gateway failure without an uncaught error", async () => {
    mockGetToken = jest.fn(async () => "test-token");
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const warnMock = jest.spyOn(console, "warn").mockImplementation();

    const view = await renderCryptoProvider();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cryptoValue?.isReady).toBe(true);
    });
    expect(warnMock).not.toHaveBeenCalled();

    view.unmount();
    fetchMock.mockRestore();
    warnMock.mockRestore();
  });

  it("does not re-register the public key when only getToken changes identity", async () => {
    mockGetToken = jest.fn(async () => "first-token");
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const view = await renderCryptoProvider();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockGetToken = jest.fn(async () => "refreshed-token");
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.unmount();
    fetchMock.mockRestore();
  });

  it("keeps encrypted rooms unavailable until public-key registration succeeds", async () => {
    mockGetToken = jest.fn(async () => "test-token");
    let resolveRegistration: ((response: Response) => void) | null = null;
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRegistration = resolve;
        }),
    );

    const view = render(
      <CryptoProvider>
        <CryptoProbe />
      </CryptoProvider>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cryptoValue?.publicKeyB64).not.toBe("");
    });
    expect(cryptoValue?.isReady).toBe(false);

    await act(async () => {
      resolveRegistration?.({ ok: true, status: 200 } as Response);
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));

    view.unmount();
    fetchMock.mockRestore();
  });

  it("registers once again when the signed-in identity changes", async () => {
    mockGetToken = jest.fn(async () => "test-token");
    const nextRegistrationResolvers: Array<(response: Response) => void> = [];
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockImplementation(
        () =>
        new Promise<Response>((resolve) => {
          nextRegistrationResolvers.push(resolve);
        }),
      );
    const view = await renderCryptoProvider();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockAuthUserId = "next-user";
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });
    await waitFor(() => expect(nextRegistrationResolvers).toHaveLength(1));
    expect(cryptoValue?.isReady).toBe(false);

    await act(async () => {
      nextRegistrationResolvers[0]?.({ ok: true, status: 200 } as Response);
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.unmount();
    fetchMock.mockRestore();
  });

  it("persists the device identity keypair in native secure storage and reuses it after remount", async () => {
    const firstView = await renderCryptoProvider();
    const firstPublicKey = cryptoValue?.publicKeyB64;
    expect(firstPublicKey).toBeTruthy();

    const storedKeypair = mockSecureStore.get(deviceKeypairStorageKey("crypto-test-user"));
    expect(storedKeypair).toBeTruthy();
    expect(JSON.parse(storedKeypair as string)).toEqual({
      secretKey: expect.any(String),
      registrationVersion: expect.any(Number),
    });

    firstView.unmount();
    await renderCryptoProvider();

    expect(cryptoValue?.publicKeyB64).toBe(firstPublicKey);
    expect(mockSecureStore.size).toBe(1);
  });

  it("generates a room key, persists it, and restores it after remount", async () => {
    const firstView = await renderCryptoProvider();
    let generatedKey: Uint8Array | undefined;

    await act(async () => {
      generatedKey = await cryptoValue?.generateRoomKey("room-42");
    });

    expect(generatedKey).toHaveLength(nacl.secretbox.keyLength);
    expect(cryptoValue?.getRoomKey("room-42")).toEqual(generatedKey);
    expect(mockSecureStore.get(roomKeyStorageKey("crypto-test-user", "room-42"))).toBe(
      encodeBase64(generatedKey as Uint8Array),
    );

    firstView.unmount();
    const secondView = await renderCryptoProvider();

    await act(async () => {
      await cryptoValue?.loadRoomKey("room-42");
    });

    expect(cryptoValue?.getRoomKey("room-42")).toEqual(generatedKey);
    secondView.unmount();
  });

  it("saves and restores keys for account and room identifiers outside the secure-store alphabet", async () => {
    // Room IDs derive from user-typed names and joined room IDs are typed
    // directly, so apostrophes, slashes, spaces, colons, and non-ASCII text
    // all reach storage. Every key the mock receives must still satisfy the
    // native rule (the mock throws otherwise) and round-trip after a remount.
    const oddUserId = "user_2abc:o'brien/déjà vu 🔐";
    const oddRoomId = "ana's/design:team 🚀";
    mockAuthUserId = oddUserId;

    const firstView = await renderCryptoProvider();
    const firstPublicKey = cryptoValue?.publicKeyB64;
    expect(firstPublicKey).toBeTruthy();
    let generatedKey: Uint8Array | undefined;
    await act(async () => {
      generatedKey = await cryptoValue?.generateRoomKey(oddRoomId);
    });

    expect(cryptoValue?.roomKeyPersistenceFailures.size).toBe(0);
    expect(mockSecureStore.get(deviceKeypairStorageKey(oddUserId))).toBeTruthy();
    expect(mockSecureStore.get(roomKeyStorageKey(oddUserId, oddRoomId))).toBe(
      encodeBase64(generatedKey as Uint8Array),
    );
    expect(mockSecureStore.size).toBe(2);
    for (const storedKey of mockSecureStore.keys()) {
      expect(storedKey).toMatch(SECURE_STORE_KEY_PATTERN);
    }

    firstView.unmount();
    const secondView = await renderCryptoProvider();

    expect(cryptoValue?.publicKeyB64).toBe(firstPublicKey);
    await act(async () => {
      await cryptoValue?.loadRoomKey(oddRoomId);
    });
    expect(cryptoValue?.roomKeyPersistenceFailures.size).toBe(0);
    expect(cryptoValue?.getRoomKey(oddRoomId)).toEqual(generatedKey);
    expect(mockSecureStore.size).toBe(2);
    secondView.unmount();
  });

  it("logs the real cause and keeps an in-memory identity when the device key cannot be saved", async () => {
    const warnMock = jest.spyOn(console, "warn").mockImplementation();
    try {
      mockDeviceKeyWriteFailure = true;
      const view = await renderCryptoProvider();

      // The app still works for this launch, but nothing was persisted and
      // the underlying error (not a generic "unavailable") is on record.
      expect(cryptoValue?.publicKeyB64).toBeTruthy();
      expect(mockSecureStore.has(deviceKeypairStorageKey("crypto-test-user"))).toBe(false);
      expect(warnMock).toHaveBeenCalledWith(
        "Device encryption identity could not be loaded from or saved to secure storage",
        mockDeviceKeyWriteError,
      );
      view.unmount();
    } finally {
      warnMock.mockRestore();
    }
  });

  it("settles a room key load when secure storage cannot be read and recovers on retry", async () => {
    const savedKey = new Uint8Array(nacl.secretbox.keyLength).fill(3);
    mockSecureStore.set(
      roomKeyStorageKey("crypto-test-user", "room-42"),
      encodeBase64(savedKey),
    );
    mockRoomKeyReadFailure = true;
      const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = await renderCryptoProvider();

    // The pre-fix behavior rejected here, which left room screens waiting
    // forever; the load must resolve and report a retryable "load" failure.
    await act(async () => {
      await expect(cryptoValue?.loadRoomKey("room-42")).resolves.toBeUndefined();
    });

    expect(cryptoValue?.getRoomKey("room-42")).toBeNull();
    expect(cryptoValue?.roomKeyPersistenceFailures.get("room-42")).toMatchObject({
      roomId: "room-42",
      kind: "load",
    });
    expect(warnMock).toHaveBeenCalledWith(
      "Saved room key could not be read from secure storage",
      "Could not read the item in SecureStore",
    );

    // Retrying while storage is still unreadable keeps the failure in place.
    let retried: boolean | undefined;
    await act(async () => {
      retried = await cryptoValue?.retryRoomKeyPersistence("room-42");
    });
    expect(retried).toBe(false);
    expect(cryptoValue?.roomKeyPersistenceFailures.has("room-42")).toBe(true);

    // Once storage is readable again the retry restores the saved key: no
    // replacement key was generated in the meantime.
    mockRoomKeyReadFailure = false;
    await act(async () => {
      retried = await cryptoValue?.retryRoomKeyPersistence("room-42");
    });
    expect(retried).toBe(true);
    expect(cryptoValue?.roomKeyPersistenceFailures.has("room-42")).toBe(false);
    expect(cryptoValue?.getRoomKey("room-42")).toEqual(savedKey);

    warnMock.mockRestore();
    view.unmount();
  });

  it("treats a corrupted saved room key as absent instead of failing the load", async () => {
    mockSecureStore.set(
      roomKeyStorageKey("crypto-test-user", "room-42"),
      "not*valid*base64",
    );
      const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = await renderCryptoProvider();

    await act(async () => {
      await expect(cryptoValue?.loadRoomKey("room-42")).resolves.toBeUndefined();
    });

    expect(cryptoValue?.getRoomKey("room-42")).toBeNull();
    expect(cryptoValue?.roomKeyPersistenceFailures.has("room-42")).toBe(false);
    expect(warnMock).toHaveBeenCalledWith(
      "Saved room key is unreadable and will be ignored.",
    );

    warnMock.mockRestore();
    view.unmount();
  });

  it.each([
    ["shorter than", nacl.secretbox.keyLength - 16],
    ["longer than", nacl.secretbox.keyLength + 1],
  ])(
    "treats a decodable saved room key %s the secretbox size as absent",
    async (_label, byteLength) => {
      mockSecureStore.set(
        roomKeyStorageKey("crypto-test-user", "room-42"),
        encodeBase64(new Uint8Array(byteLength).fill(7)),
      );
      const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = await renderCryptoProvider();

      await act(async () => {
        await expect(cryptoValue?.loadRoomKey("room-42")).resolves.toBeUndefined();
      });

      expect(cryptoValue?.getRoomKey("room-42")).toBeNull();
      expect(cryptoValue?.roomKeyPersistenceFailures.has("room-42")).toBe(false);
      expect(cryptoValue?.encryptMessage("hello", "room-42")).toBeNull();
      expect(warnMock).toHaveBeenCalledWith(
        "Saved room key is unreadable and will be ignored.",
      );

      // A freshly generated key replaces the unusable entry and works end to end.
      let generated: Uint8Array | undefined;
      await act(async () => {
        generated = await cryptoValue?.generateRoomKey("room-42");
      });
      expect(generated).toHaveLength(nacl.secretbox.keyLength);
      const sealed = cryptoValue?.encryptMessage("hello", "room-42");
      expect(sealed).not.toBeNull();
      expect(
        cryptoValue?.decryptMessage(sealed!.ciphertextB64, sealed!.nonceB64, "room-42"),
      ).toBe("hello");
      expect(
        mockSecureStore.get(roomKeyStorageKey("crypto-test-user", "room-42")),
      ).toBe(encodeBase64(generated!));

      warnMock.mockRestore();
      view.unmount();
    },
  );

  it("refuses to install, save, or envelope a room key that is not the secretbox size", async () => {
    const view = await renderCryptoProvider();
    const crypto = cryptoValue as CryptoContextValue;
    const shortKey = new Uint8Array(nacl.secretbox.keyLength - 1).fill(3);
    const longKey = new Uint8Array(nacl.secretbox.keyLength + 8).fill(3);

    for (const badKey of [shortKey, longKey]) {
      await expect(crypto.setRoomKey("room-42", badKey)).rejects.toThrow(
        `Room keys must be exactly ${nacl.secretbox.keyLength} bytes.`,
      );
      expect(crypto.getRoomKey("room-42")).toBeNull();
      expect(crypto.encryptRoomKey(badKey, crypto.publicKeyB64)).toBeNull();
    }
    expect(
      mockSecureStore.has(roomKeyStorageKey("crypto-test-user", "room-42")),
    ).toBe(false);

    // An authentic envelope whose payload is not a key is rejected on receipt
    // instead of being installed as the room key.
    const senderPair = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const bogusEnvelope = nacl.box(
      shortKey,
      nonce,
      decodeBase64(crypto.publicKeyB64),
      senderPair.secretKey,
    );
    expect(
      crypto.decryptRoomKeyEnvelope(
        encodeBase64(bogusEnvelope),
        encodeBase64(nonce),
        encodeBase64(senderPair.publicKey),
      ),
    ).toBeNull();

    view.unmount();
  });

  it("round trips room-key envelopes with a fresh nonce", async () => {
    await renderCryptoProvider();
    const roomKey = new Uint8Array(nacl.secretbox.keyLength).map(
      (_, index) => index,
    );

    const firstEnvelope = cryptoValue?.encryptRoomKey(
      roomKey,
      cryptoValue.publicKeyB64,
    );
    const secondEnvelope = cryptoValue?.encryptRoomKey(
      roomKey,
      cryptoValue.publicKeyB64,
    );

    expect(firstEnvelope).not.toBeNull();
    expect(firstEnvelope?.nonceB64).toHaveLength(
      Math.ceil((nacl.box.nonceLength * 4) / 3),
    );
    expect(secondEnvelope?.nonceB64).not.toBe(firstEnvelope?.nonceB64);
    expect(
      cryptoValue?.decryptRoomKeyEnvelope(
        firstEnvelope!.ciphertextB64,
        firstEnvelope!.nonceB64,
        cryptoValue.publicKeyB64,
      ),
    ).toEqual(roomKey);
  });

  it("delivers a room key between independent devices and rejects invalid envelopes", async () => {
    mockAuthUserId = "sender-device";
    const senderView = await renderCryptoProvider();
    const sender = cryptoValue as CryptoContextValue;
    senderView.unmount();

    mockSecureStore.clear();
    globalThis.localStorage?.clear();
    mockAuthUserId = "recipient-device";
    const recipientView = await renderCryptoProvider();
    const recipient = cryptoValue as CryptoContextValue;
    const roomKey = new Uint8Array(nacl.secretbox.keyLength).map(
      (_, index) => index,
    );

    expect(recipient.publicKeyB64).not.toBe(sender.publicKeyB64);
    const envelope = sender.encryptRoomKey(roomKey, recipient.publicKeyB64);

    expect(envelope).not.toBeNull();
    expect(
      recipient.decryptRoomKeyEnvelope(
        envelope!.ciphertextB64,
        envelope!.nonceB64,
        sender.publicKeyB64,
      ),
    ).toEqual(roomKey);
    expect(
      sender.decryptRoomKeyEnvelope(
        envelope!.ciphertextB64,
        envelope!.nonceB64,
        sender.publicKeyB64,
      ),
    ).toBeNull();
    expect(
      recipient.decryptRoomKeyEnvelope(
        envelope!.ciphertextB64,
        envelope!.nonceB64,
        recipient.publicKeyB64,
      ),
    ).toBeNull();

    const tamperedCiphertext = decodeBase64(envelope!.ciphertextB64);
    tamperedCiphertext[0] ^= 1;
    expect(
      recipient.decryptRoomKeyEnvelope(
        encodeBase64(tamperedCiphertext),
        envelope!.nonceB64,
        sender.publicKeyB64,
      ),
    ).toBeNull();

    recipientView.unmount();
  });

  it("keeps a failed room key in memory and surfaces a retryable persistence failure", async () => {
    await renderCryptoProvider();
    mockRoomKeyWriteFailure = true;

    const warnMock = jest.spyOn(console, "warn").mockImplementation();
    try {
      await act(async () => {
        await expect(cryptoValue?.generateRoomKey("room-42")).rejects.toMatchObject({
          name: "RoomKeyPersistenceError",
          roomId: "room-42",
        });
      });
      // The retry UX is unchanged, and the underlying storage error is logged
      // so a deterministic failure cannot hide behind the generic message.
      expect(warnMock).toHaveBeenCalledWith(
        "Room encryption key could not be saved to secure storage",
        "Secure storage unavailable",
      );
    } finally {
      warnMock.mockRestore();
    }

    const inMemoryKey = cryptoValue?.getRoomKey("room-42");
    expect(inMemoryKey).toHaveLength(nacl.secretbox.keyLength);
    expect(cryptoValue?.roomKeyPersistenceFailures.get("room-42")).toMatchObject({
      roomId: "room-42",
    });

    mockRoomKeyWriteFailure = false;
    await act(async () => {
      await expect(
        cryptoValue?.retryRoomKeyPersistence("room-42"),
      ).resolves.toBe(true);
    });

    expect(cryptoValue?.getRoomKey("room-42")).toEqual(inMemoryKey);
    expect(cryptoValue?.roomKeyPersistenceFailures.has("room-42")).toBe(false);
  });

  it("does not report persistence success after the active account changes", async () => {
    const view = await renderCryptoProvider();
    mockRoomKeyWriteRelease = () => undefined;
    const savePromise = cryptoValue!.generateRoomKey("room-42");

    await waitFor(() => {
      expect(mockRoomKeyWriteRelease).not.toBeNull();
    });

    mockAuthUserId = "other-user";
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });
    const releaseWrite = mockRoomKeyWriteRelease;
    mockRoomKeyWriteRelease = null;
    releaseWrite?.();

    await act(async () => {
      await expect(savePromise).rejects.toMatchObject({
        name: "RoomKeyPersistenceError",
        reason: "identity_changed",
        roomId: "room-42",
      });
    });

    expect(cryptoValue?.getRoomKey("room-42")).toBeNull();
  });

  it("round trips messages and arbitrary bytes with unique nonces", async () => {
    await renderCryptoProvider();
    await act(async () => {
      await cryptoValue?.generateRoomKey("room-42");
    });

    const firstMessage = cryptoValue?.encryptMessage("Hello 🔐", "room-42");
    const secondMessage = cryptoValue?.encryptMessage("Hello 🔐", "room-42");
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encryptedBytes = cryptoValue?.encryptBytes(bytes, "room-42");

    expect(firstMessage).not.toBeNull();
    expect(secondMessage?.nonceB64).not.toBe(firstMessage?.nonceB64);
    expect(
      cryptoValue?.decryptMessage(
        firstMessage!.ciphertextB64,
        firstMessage!.nonceB64,
        "room-42",
      ),
    ).toBe("Hello 🔐");
    expect(encryptedBytes).not.toBeNull();
    expect(
      cryptoValue?.decryptBytes(
        encryptedBytes!.ciphertextB64,
        encryptedBytes!.nonceB64,
        "room-42",
      ),
    ).toEqual(bytes);
  });

  it("rejects invalid ciphertext and never returns plaintext without a room key", async () => {
    await renderCryptoProvider();
    expect(cryptoValue?.encryptMessage("secret", "missing-room")).toBeNull();
    expect(
      cryptoValue?.decryptMessage(
        "invalid ciphertext",
        "invalid nonce",
        "missing-room",
      ),
    ).toBeNull();
    expect(cryptoValue?.encryptBytes(new Uint8Array([1]), "missing-room")).toBeNull();
    expect(
      cryptoValue?.decryptBytes(
        "invalid ciphertext",
        "invalid nonce",
        "missing-room",
      ),
    ).toBeNull();

    await act(async () => {
      await cryptoValue?.generateRoomKey("room-42");
    });
    const encrypted = cryptoValue?.encryptMessage("secret", "room-42");
    const tamperedCiphertext = decodeBase64(encrypted!.ciphertextB64);
    tamperedCiphertext[0] ^= 1;

    expect(
      cryptoValue?.decryptMessage(
        encodeBase64(tamperedCiphertext),
        encrypted!.nonceB64,
        "room-42",
      ),
    ).toBeNull();
    expect(
      cryptoValue?.decryptMessage(
        encrypted!.ciphertextB64,
        "invalid nonce",
        "room-42",
      ),
    ).toBeNull();
  });
});
