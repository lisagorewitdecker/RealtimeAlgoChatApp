import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import {
  CryptoProvider,
  DEVICE_KEY_REGISTRATION_SLOW_MS,
  type CryptoContextValue,
  type DeviceIdentityResetResult,
  useCrypto,
} from "../contexts/CryptoContext";
import { toSecureStoreKey } from "../lib/secureStorageKey";

// Native secure storage receives encoded key names (lib/secureStorageKey.ts),
// so every lookup below goes through the same encoding as the provider.
const deviceKeyStorageKey = (userId: string) =>
  toSecureStoreKey(`devstudio_device_keypair_v1:${userId}`);
const roomKeyStorageKey = (userId: string, roomId: string) =>
  toSecureStoreKey(`devstudio_roomkey:${userId}:${roomId}`);
const mockSecureStore = new Map<string, string>();
let mockRandomCounter = 0;
let mockDeviceKeyWriteFailure = false;
let mockDeviceKeyWriteRelease: (() => void) | null = null;
let mockAuthUserId: string | null = "crypto-test-user";
let mockGetToken: (() => Promise<string | null>) | null = null;

jest.mock("expo-secure-store", () => {
  const { toSecureStoreKey: encodeKey } = jest.requireActual(
    "../lib/secureStorageKey",
  ) as typeof import("../lib/secureStorageKey");
  const devicePrefix = encodeKey("devstudio_device_keypair_v1:");
  return {
    getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      const isDeviceKey = key.startsWith(devicePrefix);
      if (isDeviceKey && mockDeviceKeyWriteRelease) {
        await new Promise<void>((resolve) => {
          const release = mockDeviceKeyWriteRelease;
          mockDeviceKeyWriteRelease = () => {
            release?.();
            resolve();
          };
        });
      }
      if (mockDeviceKeyWriteFailure && isDeviceKey) {
        throw new Error("Secure storage unavailable");
      }
      mockSecureStore.set(key, value);
    }),
  };
});

jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn((length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (mockRandomCounter + index * 7) % 256;
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

function renderProvider() {
  return render(
    <CryptoProvider>
      <CryptoProbe />
    </CryptoProvider>,
  );
}

async function renderReadyProvider() {
  const view = renderProvider();
  await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
  return view;
}

function storedPublicKey(userId: string): string | null {
  const saved = mockSecureStore.get(deviceKeyStorageKey(userId));
  if (!saved) return null;
  const secretKey = decodeBase64(JSON.parse(saved).secretKey);
  return encodeBase64(nacl.box.keyPair.fromSecretKey(secretKey).publicKey);
}

const okResponse = () => ({ ok: true, status: 200 }) as Response;

interface RegistrationWrite {
  publicKey: string;
  previousPublicKey?: string | null;
}
type PutOverride = (write: RegistrationWrite) => Response | Promise<Response>;
type GetOverride = () => Response | Promise<Response>;

/**
 * Stand-in for PUT/GET /api/profile with the real route's compare-and-set
 * rule: a write applies only when the server holds `previousPublicKey`
 * (absent or null meaning no key, or already this key); anything else is a
 * 409 naming the key the server kept. GET reads the current key.
 */
function createProfileServer() {
  const state = {
    publicKey: null as string | null,
    puts: [] as RegistrationWrite[],
    gets: 0,
    nextPut: [] as PutOverride[],
    nextGet: [] as GetOverride[],
  };
  const applyWrite = (write: RegistrationWrite): Response => {
    const expected = write.previousPublicKey ?? null;
    if (
      state.publicKey === write.publicKey ||
      state.publicKey === expected
    ) {
      state.publicKey = write.publicKey;
      return okResponse();
    }
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: "A different encryption key is registered for this account.",
        code: "PUBLIC_KEY_CONFLICT",
        publicKey: state.publicKey,
      }),
    } as Response;
  };
  const handler = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const write = JSON.parse(String(init.body)) as RegistrationWrite;
      state.puts.push(write);
      const override = state.nextPut.shift();
      if (override) return override(write);
      return applyWrite(write);
    }
    state.gets += 1;
    const override = state.nextGet.shift();
    if (override) return override();
    return {
      ok: true,
      status: 200,
      json: async () => ({ publicKey: state.publicKey }),
    } as Response;
  };
  return { state, handler, applyWrite };
}

function deferredPut(server: ReturnType<typeof createProfileServer>) {
  let release: (() => void) | null = null;
  server.state.nextPut.push(
    (write) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(server.applyWrite(write));
      }),
  );
  return {
    get isPending() {
      return release !== null;
    },
    release: () => release?.(),
  };
}

const sentKeys = (server: ReturnType<typeof createProfileServer>) =>
  server.state.puts.map((write) => write.publicKey);

describe("device encryption identity reset", () => {
  let fetchMock: jest.SpyInstance;
  let server: ReturnType<typeof createProfileServer>;

  beforeEach(() => {
    mockSecureStore.clear();
    globalThis.localStorage?.clear();
    mockRandomCounter = 0;
    mockDeviceKeyWriteFailure = false;
    mockDeviceKeyWriteRelease = null;
    mockAuthUserId = "crypto-test-user";
    mockGetToken = jest.fn(async () => "test-token");
    cryptoValue = null;
    server = createProfileServer();
    fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(server.handler as typeof fetch);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("replaces the device key, keeps saved room keys, and reopens rooms only after the new key registers", async () => {
    const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = await renderReadyProvider();
    const before = cryptoValue as CryptoContextValue;
    const previousPublicKey = before.publicKeyB64;
    let roomKey: Uint8Array | undefined;
    await act(async () => {
      roomKey = await before.generateRoomKey("room-42");
    });
    const envelopeForOldIdentity = before.encryptRoomKey(roomKey!, previousPublicKey)!;
    // Startup registration never asserts a previous key: it can only fill an
    // empty slot or re-send the same key, never displace another device.
    expect(server.state.puts).toEqual([{ publicKey: previousPublicKey }]);

    server.state.nextPut.push(() => ({ ok: false, status: 502 }) as Response);
    const secondAttempt = deferredPut(server);

    let result: DeviceIdentityResetResult | undefined;
    await act(async () => {
      result = await before.resetDeviceIdentity();
    });

    expect(result).toEqual({ status: "reset", publicKeyB64: expect.any(String) });
    if (result?.status !== "reset") throw new Error("Expected the reset to succeed");
    const nextPublicKey = result.publicKeyB64;
    expect(nextPublicKey).not.toBe(previousPublicKey);
    expect(cryptoValue?.publicKeyB64).toBe(nextPublicKey);
    expect(storedPublicKey("crypto-test-user")).toBe(nextPublicKey);
    // Encrypted rooms stay closed until the server confirms the replacement.
    expect(cryptoValue?.isReady).toBe(false);
    expect(["registering", "retrying"]).toContain(cryptoValue?.deviceKeyStatus);

    // Locally saved room keys survive; envelopes addressed to the old identity do not open.
    expect(cryptoValue?.getRoomKey("room-42")).toEqual(roomKey);
    expect(mockSecureStore.get(roomKeyStorageKey("crypto-test-user", "room-42"))).toBe(
      encodeBase64(roomKey!),
    );
    expect(
      cryptoValue?.decryptRoomKeyEnvelope(
        envelopeForOldIdentity.ciphertextB64,
        envelopeForOldIdentity.nonceB64,
        previousPublicKey,
      ),
    ).toBeNull();
    const freshEnvelope = cryptoValue!.encryptRoomKey(roomKey!, nextPublicKey)!;
    expect(
      cryptoValue?.decryptRoomKeyEnvelope(
        freshEnvelope.ciphertextB64,
        freshEnvelope.nonceB64,
        nextPublicKey,
      ),
    ).toEqual(roomKey);

    await waitFor(() => expect(cryptoValue?.deviceKeyStatus).toBe("retrying"));
    expect(cryptoValue?.isReady).toBe(false);
    await waitFor(() => expect(secondAttempt.isPending).toBe(true));
    // The takeover names the key it replaces (read back from the server first).
    expect(server.state.puts).toEqual([
      { publicKey: previousPublicKey },
      { publicKey: nextPublicKey, previousPublicKey },
      { publicKey: nextPublicKey, previousPublicKey },
    ]);
    expect(server.state.gets).toBe(2);
    expect(server.state.publicKey).toBe(previousPublicKey);

    await act(async () => {
      secondAttempt.release();
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");
    expect(cryptoValue?.publicKeyB64).toBe(nextPublicKey);
    expect(server.state.publicKey).toBe(nextPublicKey);

    view.unmount();
    warnMock.mockRestore();
  });

  it("keeps the reset key when a delayed write from another session lands afterwards", async () => {
    const view = await renderReadyProvider();
    const previousPublicKey = cryptoValue!.publicKeyB64;

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    const nextPublicKey = cryptoValue!.publicKeyB64;
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(server.state.publicKey).toBe(nextPublicKey);

    // Another device or session of the same account still holds the old key:
    // its periodic re-registration and a takeover it prepared before the
    // reset both arrive late. The server refuses each one.
    const staleWrites: RegistrationWrite[] = [
      { publicKey: previousPublicKey },
      { publicKey: previousPublicKey, previousPublicKey: null },
      { publicKey: encodeBase64(nacl.box.keyPair().publicKey), previousPublicKey },
    ];
    for (const write of staleWrites) {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(write),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "PUBLIC_KEY_CONFLICT",
        publicKey: nextPublicKey,
      });
    }
    expect(server.state.publicKey).toBe(nextPublicKey);
    // The reset device is still the registered identity, with rooms open.
    expect(cryptoValue?.isReady).toBe(true);
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");
    expect(cryptoValue?.publicKeyB64).toBe(nextPublicKey);

    view.unmount();
  });

  it("reports itself superseded instead of overwriting a key another device registered", async () => {
    const otherDeviceKey = encodeBase64(nacl.box.keyPair().publicKey);
    server.state.publicKey = otherDeviceKey;
    const view = renderProvider();

    await waitFor(() => expect(cryptoValue?.deviceKeyStatus).toBe("superseded"));
    const localPublicKey = cryptoValue!.publicKeyB64;
    expect(cryptoValue?.isReady).toBe(false);
    expect(cryptoValue?.deviceKeyConflict).toEqual({ registeredPublicKeyB64: otherDeviceKey });
    // Exactly one plain registration was attempted; no retries, no takeover.
    expect(server.state.puts).toEqual([{ publicKey: localPublicKey }]);
    expect(server.state.publicKey).toBe(otherDeviceKey);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(server.state.puts).toHaveLength(1);
    expect(cryptoValue?.deviceKeyStatus).toBe("superseded");

    // An explicit reset is the only way to take the registration over.
    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    const nextPublicKey = cryptoValue!.publicKeyB64;
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");
    expect(cryptoValue?.deviceKeyConflict).toBeNull();
    expect(server.state.puts.at(-1)).toEqual({
      publicKey: nextPublicKey,
      previousPublicKey: otherDeviceKey,
    });
    expect(server.state.publicKey).toBe(nextPublicKey);

    view.unmount();
  });

  it("closes encrypted rooms when the server reports a different registered key", async () => {
    const view = await renderReadyProvider();
    const ownKey = cryptoValue!.publicKeyB64;
    const otherDeviceKey = encodeBase64(nacl.box.keyPair().publicKey);

    // A report of this device's own key is not a conflict.
    act(() => {
      cryptoValue!.markDeviceKeySuperseded(ownKey);
    });
    expect(cryptoValue?.isReady).toBe(true);
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");

    act(() => {
      cryptoValue!.markDeviceKeySuperseded(otherDeviceKey);
    });
    expect(cryptoValue?.isReady).toBe(false);
    expect(cryptoValue?.deviceKeyStatus).toBe("superseded");
    expect(cryptoValue?.deviceKeyConflict).toEqual({ registeredPublicKeyB64: otherDeviceKey });
    // The local key stays; nothing is sent to the server on its own.
    expect(cryptoValue?.publicKeyB64).toBe(ownKey);
    expect(server.state.puts).toHaveLength(1);

    view.unmount();
  });

  it("re-reads and retries a takeover that lost a race, then gives up as superseded", async () => {
    const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = await renderReadyProvider();
    const previousPublicKey = cryptoValue!.publicKeyB64;
    const racingKeys = [
      encodeBase64(nacl.box.keyPair().publicKey),
      encodeBase64(nacl.box.keyPair().publicKey),
      encodeBase64(nacl.box.keyPair().publicKey),
    ];
    // Between each read-back and write, another device registers a new key.
    for (const racingKey of racingKeys) {
      server.state.nextPut.push((write) => {
        server.state.publicKey = racingKey;
        return server.applyWrite(write);
      });
    }

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    const nextPublicKey = cryptoValue!.publicKeyB64;

    await waitFor(() => expect(cryptoValue?.deviceKeyStatus).toBe("superseded"));
    expect(cryptoValue?.isReady).toBe(false);
    expect(cryptoValue?.deviceKeyConflict).toEqual({
      registeredPublicKeyB64: racingKeys[2],
    });
    // Three bounded attempts, each asserting the key it had just read back.
    expect(server.state.puts.slice(1)).toEqual([
      { publicKey: nextPublicKey, previousPublicKey },
      { publicKey: nextPublicKey, previousPublicKey: racingKeys[0] },
      { publicKey: nextPublicKey, previousPublicKey: racingKeys[1] },
    ]);
    expect(server.state.gets).toBe(3);
    expect(server.state.publicKey).toBe(racingKeys[2]);

    // A later reset takes over from the current key normally.
    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(server.state.puts.at(-1)).toEqual({
      publicKey: cryptoValue!.publicKeyB64,
      previousPublicKey: racingKeys[2],
    });

    view.unmount();
    warnMock.mockRestore();
  });

  it("wins a takeover on the retry when the first attempt lost a race", async () => {
    const view = await renderReadyProvider();
    const previousPublicKey = cryptoValue!.publicKeyB64;
    const racingKey = encodeBase64(nacl.box.keyPair().publicKey);
    server.state.nextPut.push((write) => {
      server.state.publicKey = racingKey;
      return server.applyWrite(write);
    });

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    const nextPublicKey = cryptoValue!.publicKeyB64;

    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");
    expect(server.state.puts.slice(1)).toEqual([
      { publicKey: nextPublicKey, previousPublicKey },
      { publicKey: nextPublicKey, previousPublicKey: racingKey },
    ]);
    expect(server.state.publicKey).toBe(nextPublicKey);

    view.unmount();
  });

  it("refuses a reset while the current key is still registering or another reset is in flight", async () => {
    const initialRegistration = deferredPut(server);
    const view = renderProvider();
    await waitFor(() => expect(cryptoValue?.publicKeyB64).not.toBe(""));
    const pendingPublicKey = cryptoValue!.publicKeyB64;
    expect(cryptoValue?.deviceKeyStatus).toBe("registering");

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toEqual({
        status: "not_ready",
      });
    });
    expect(cryptoValue?.publicKeyB64).toBe(pendingPublicKey);
    expect(sentKeys(server)).toEqual([pendingPublicKey]);

    await act(async () => {
      initialRegistration.release();
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));

    const ready = cryptoValue as CryptoContextValue;
    let results: DeviceIdentityResetResult[] = [];
    await act(async () => {
      results = await Promise.all([
        ready.resetDeviceIdentity(),
        ready.resetDeviceIdentity(),
      ]);
    });
    expect(results.map((entry) => entry.status).sort()).toEqual(["not_ready", "reset"]);
    const resetResult = results.find(
      (entry): entry is Extract<DeviceIdentityResetResult, { status: "reset" }> =>
        entry.status === "reset",
    );
    if (!resetResult) throw new Error("Expected one reset to succeed");
    // Secure storage and the in-memory identity agree on the single new key.
    expect(cryptoValue?.publicKeyB64).toBe(resetResult.publicKeyB64);
    expect(storedPublicKey("crypto-test-user")).toBe(resetResult.publicKeyB64);
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(server.state.publicKey).toBe(resetResult.publicKeyB64);

    view.unmount();
  });

  it("reports a slow pending registration, clears it on completion, and sends nothing early", async () => {
    jest.useFakeTimers();
    try {
      const initialRegistration = deferredPut(server);
      const view = renderProvider();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(server.state.puts).toHaveLength(1);
      expect(cryptoValue?.isDeviceKeyRegistrationSlow).toBe(false);

      act(() => {
        jest.advanceTimersByTime(DEVICE_KEY_REGISTRATION_SLOW_MS - 1);
      });
      expect(cryptoValue?.isDeviceKeyRegistrationSlow).toBe(false);
      expect(server.state.puts).toHaveLength(1);

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(cryptoValue?.isDeviceKeyRegistrationSlow).toBe(true);
      expect(cryptoValue?.isReady).toBe(false);
      expect(server.state.puts).toHaveLength(1);

      await act(async () => {
        initialRegistration.release();
        await Promise.resolve();
      });
      expect(cryptoValue?.isDeviceKeyRegistrationSlow).toBe(false);
      expect(cryptoValue?.isReady).toBe(true);
      expect(server.state.puts).toHaveLength(1);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the current identity when secure storage rejects the new key", async () => {
    const view = await renderReadyProvider();
    const previousPublicKey = cryptoValue!.publicKeyB64;
    const previousStored = mockSecureStore.get(deviceKeyStorageKey("crypto-test-user"));
    mockDeviceKeyWriteFailure = true;

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toEqual({
        status: "storage_unavailable",
      });
    });

    expect(cryptoValue?.publicKeyB64).toBe(previousPublicKey);
    expect(cryptoValue?.isReady).toBe(true);
    expect(cryptoValue?.deviceKeyStatus).toBe("registered");
    expect(mockSecureStore.get(deviceKeyStorageKey("crypto-test-user"))).toBe(previousStored);
    expect(sentKeys(server)).toEqual([previousPublicKey]);

    // Once storage recovers the reset succeeds without any extra state.
    mockDeviceKeyWriteFailure = false;
    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(cryptoValue?.publicKeyB64).not.toBe(previousPublicKey);
    expect(server.state.publicKey).toBe(cryptoValue?.publicKeyB64);

    view.unmount();
  });

  it("rejects a reset without a signed-in account", async () => {
    mockAuthUserId = null;
    const view = await renderReadyProvider();

    expect(cryptoValue?.deviceKeyStatus).toBe("unavailable");
    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toEqual({
        status: "unauthenticated",
      });
    });
    expect(mockSecureStore.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    view.unmount();
  });

  it("never adopts a key for an account that signed out mid-reset and leaves other accounts untouched", async () => {
    const otherSecret = encodeBase64(nacl.box.keyPair().secretKey);
    mockSecureStore.set(
      deviceKeyStorageKey("other-user"),
      JSON.stringify({ secretKey: otherSecret }),
    );
    const view = await renderReadyProvider();
    const firstPublicKey = cryptoValue!.publicKeyB64;
    mockDeviceKeyWriteRelease = () => undefined;
    const resetPromise = cryptoValue!.resetDeviceIdentity();
    await waitFor(() => expect(mockDeviceKeyWriteRelease).not.toBeNull());

    mockAuthUserId = "other-user";
    // The fake server holds a single account's key; the other account has
    // nothing registered yet, so its own key registers without a conflict.
    server.state.publicKey = null;
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });
    const releaseWrite = mockDeviceKeyWriteRelease;
    mockDeviceKeyWriteRelease = null;
    releaseWrite?.();

    await act(async () => {
      await expect(resetPromise).resolves.toEqual({ status: "identity_changed" });
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));

    // The other account keeps its own stored key and is the active identity.
    expect(mockSecureStore.get(deviceKeyStorageKey("other-user"))).toBe(
      JSON.stringify({ secretKey: otherSecret }),
    );
    expect(cryptoValue?.publicKeyB64).toBe(storedPublicKey("other-user"));
    // The first account's replacement key stays in storage for its next sign-in
    // but was never registered under the other account's session.
    expect(storedPublicKey("crypto-test-user")).not.toBe(firstPublicKey);
    expect(sentKeys(server)).toEqual([firstPublicKey, storedPublicKey("other-user")]);

    view.unmount();
  });

  it("sends the replacement key only after an in-flight registration of the old key settles", async () => {
    const view = await renderReadyProvider();
    const previousPublicKey = cryptoValue!.publicKeyB64;

    // A periodic re-registration of the old key is still waiting on the server.
    const slowOldRegistration = deferredPut(server);
    mockGetToken = jest.fn(async () => "refreshed-token");
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });
    await waitFor(() => expect(slowOldRegistration.isPending).toBe(true));
    expect(sentKeys(server)).toEqual([previousPublicKey, previousPublicKey]);

    await act(async () => {
      await expect(cryptoValue!.resetDeviceIdentity()).resolves.toMatchObject({
        status: "reset",
      });
    });
    const nextPublicKey = cryptoValue!.publicKeyB64;
    expect(nextPublicKey).not.toBe(previousPublicKey);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The new key must not race the old one to the server.
    expect(sentKeys(server)).toEqual([previousPublicKey, previousPublicKey]);
    expect(cryptoValue?.isReady).toBe(false);

    await act(async () => {
      slowOldRegistration.release();
    });
    await waitFor(() =>
      expect(sentKeys(server)).toEqual([previousPublicKey, previousPublicKey, nextPublicKey]),
    );
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));
    expect(cryptoValue?.publicKeyB64).toBe(nextPublicKey);
    expect(server.state.publicKey).toBe(nextPublicKey);

    view.unmount();
  });
});
