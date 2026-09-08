import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import nacl from "tweetnacl";
import {
  decodeBase64,
  encodeBase64,
} from "tweetnacl-util";
import {
  CryptoProvider,
  type CryptoContextValue,
  useCrypto,
} from "../contexts/CryptoContext";

const mockSecureStore = new Map<string, string>();
let mockRandomCounter = 0;
let mockRoomKeyWriteFailure = false;
let mockRoomKeyWriteRelease: (() => void) | null = null;
let mockAuthUserId: string | null = "crypto-test-user";
let mockGetToken: (() => Promise<string | null>) | null = null;

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    if (key.startsWith("devstudio_roomkey:") && mockRoomKeyWriteRelease) {
      await new Promise<void>((resolve) => {
        const release = mockRoomKeyWriteRelease;
        mockRoomKeyWriteRelease = () => {
          release?.();
          resolve();
        };
      });
    }
    if (mockRoomKeyWriteFailure && key.startsWith("devstudio_roomkey:")) {
      throw new Error("Secure storage unavailable");
    }
    mockSecureStore.set(key, value);
  }),
}));

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

  it("ignores a successful registration response from the previous identity", async () => {
    mockGetToken = jest.fn(async () => "test-token");
    const registrationResolvers: Array<(response: Response) => void> = [];
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          registrationResolvers.push(resolve);
        }),
    );
    const view = render(
      <CryptoProvider>
        <CryptoProbe />
      </CryptoProvider>,
    );

    await waitFor(() => expect(registrationResolvers).toHaveLength(1));

    mockAuthUserId = "next-user";
    act(() => {
      view.rerender(
        <CryptoProvider>
          <CryptoProbe />
        </CryptoProvider>,
      );
    });
    await waitFor(() => expect(registrationResolvers).toHaveLength(2));
    expect(cryptoValue?.isReady).toBe(false);

    await act(async () => {
      registrationResolvers[0]?.({ ok: true, status: 200 } as Response);
    });
    expect(cryptoValue?.isReady).toBe(false);

    await act(async () => {
      registrationResolvers[1]?.({ ok: true, status: 200 } as Response);
    });
    await waitFor(() => expect(cryptoValue?.isReady).toBe(true));

    view.unmount();
    fetchMock.mockRestore();
  });

  it("generates a room key, persists it, and restores it after remount", async () => {
    const firstView = await renderCryptoProvider();
    let generatedKey: Uint8Array | undefined;

    await act(async () => {
      generatedKey = await cryptoValue?.generateRoomKey("room-42");
    });

    expect(generatedKey).toHaveLength(nacl.secretbox.keyLength);
    expect(cryptoValue?.getRoomKey("room-42")).toEqual(generatedKey);
    expect(
      mockSecureStore.get("devstudio_roomkey:crypto-test-user:room-42"),
    ).toBe(
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

    await act(async () => {
      await expect(cryptoValue?.generateRoomKey("room-42")).rejects.toMatchObject({
        name: "RoomKeyPersistenceError",
        roomId: "room-42",
      });
    });

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
