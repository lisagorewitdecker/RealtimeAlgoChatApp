import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import RoomScreen from "../app/room/[roomId]";

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
const mockHandlers = new Map<string, (payload?: any) => void>();
const mockSocket = {
  on: jest.fn((event: string, handler: (payload?: any) => void) => {
    mockHandlers.set(event, handler);
  }),
  off: jest.fn(),
  emit: jest.fn(),
};
const mockGetToken = jest.fn();
const mockRetryRoomKeyPersistence = jest.fn();
const defaultRoomKey = new Uint8Array(32).fill(7);
const mockGetRoomKey = jest.fn<Uint8Array | null, []>(() => defaultRoomKey);
const mockLoadRoomKey = jest.fn<Promise<void>, []>(async () => undefined);
const mockDecryptMessage = jest.fn();
const mockDecryptRoomKeyEnvelope = jest.fn();
const mockEncryptMessage = jest.fn();
const mockEncryptRoomKey = jest.fn();
const mockSetRoomKey = jest.fn();
const mockRoomKeyPersistenceFailures = new Map<
  string,
  { roomId: string; message: string; kind?: "save" | "load" }
>();
const mockMarkDeviceKeySuperseded = jest.fn();
// Mutable so tests can simulate device-key (re)registration between renders.
const mockCryptoState: {
  isReady: boolean;
  publicKeyB64: string;
  deviceKeyStatus: "registering" | "registered" | "superseded";
  isDeviceKeyRegistrationSlow: boolean;
} = {
  isReady: true,
  publicKeyB64: "public-key",
  deviceKeyStatus: "registered",
  isDeviceKeyRegistrationSlow: false,
};

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error" },
}));

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    roomId: "room-42",
    roomName: "Compiler room",
  }),
  useRouter: () => mockRouter,
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const mockReact = require("react");
    const { View: MockView } = require("react-native");
    return mockReact.createElement(MockView, props, children);
  },
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    userId: "user-ben",
    username: "Ben",
  }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1.4,
}));

jest.mock("@/contexts/SocketContext", () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

jest.mock("@/contexts/CryptoContext", () => ({
  useCrypto: () => ({
    isReady: mockCryptoState.isReady,
    publicKeyB64: mockCryptoState.publicKeyB64,
    deviceKeyStatus: mockCryptoState.deviceKeyStatus,
    isDeviceKeyRegistrationSlow: mockCryptoState.isDeviceKeyRegistrationSlow,
    markDeviceKeySuperseded: mockMarkDeviceKeySuperseded,
    getRoomKey: mockGetRoomKey,
    loadRoomKey: mockLoadRoomKey,
    generateRoomKey: jest.fn(),
    encryptRoomKey: mockEncryptRoomKey,
    decryptRoomKeyEnvelope: mockDecryptRoomKeyEnvelope,
    setRoomKey: mockSetRoomKey,
    decryptMessage: mockDecryptMessage,
    encryptMessage: mockEncryptMessage,
    roomKeyPersistenceFailures: mockRoomKeyPersistenceFailures,
    retryRoomKeyPersistence: mockRetryRoomKeyPersistence,
  }),
}));

jest.mock("@/components/MessageBubble", () => () => null);

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    secondary: "#1e1b4b",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    muted: "#242938",
    destructive: "#ef4444",
    online: "#22c55e",
    radius: 10,
  }),
}));

function resetRoomMocks() {
  mockHandlers.clear();
  Object.values(mockRouter).forEach((mock) => mock.mockReset());
  mockSocket.on.mockClear();
  mockSocket.off.mockClear();
  mockSocket.emit.mockClear();
  mockGetToken.mockReset().mockResolvedValue("clerk-token");
  mockRetryRoomKeyPersistence.mockReset().mockResolvedValue(true);
  mockGetRoomKey.mockReset().mockReturnValue(defaultRoomKey);
  mockLoadRoomKey.mockReset().mockResolvedValue(undefined);
  mockDecryptMessage.mockReset();
  mockDecryptRoomKeyEnvelope.mockReset();
  mockEncryptMessage.mockReset();
  mockEncryptRoomKey.mockReset();
  mockSetRoomKey.mockReset();
  mockRoomKeyPersistenceFailures.clear();
  mockMarkDeviceKeySuperseded.mockReset();
  mockCryptoState.isReady = true;
  mockCryptoState.publicKeyB64 = "public-key";
  mockCryptoState.deviceKeyStatus = "registered";
  mockCryptoState.isDeviceKeyRegistrationSlow = false;
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ ok: true }),
  }) as jest.Mock;
}

function socketEmits(event: string) {
  return mockSocket.emit.mock.calls.filter(([name]) => name === event);
}

describe("room ban handling", () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRoomMocks();
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it("registers response listeners before requesting to join", () => {
    render(<RoomScreen />);

    const errorRegistrationOrder = mockSocket.on.mock.invocationCallOrder[
      mockSocket.on.mock.calls.findIndex(([event]) => event === "error")
    ];
    const joinOrder = mockSocket.emit.mock.invocationCallOrder[
      mockSocket.emit.mock.calls.findIndex(([event]) => event === "join-room")
    ];

    expect(errorRegistrationOrder).toBeLessThan(joinOrder);
  });

  it("shows room loading feedback until the server confirms the join", () => {
    const { getByTestId, getByText, queryByTestId } = render(<RoomScreen />);

    expect(getByTestId("room-loading")).toBeTruthy();
    expect(getByText("Opening room…")).toBeTruthy();
    expect(getByText("Opening room…").props.style.fontSize).toBeCloseTo(33.6);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [],
      });
    });

    expect(queryByTestId("room-loading")).toBeNull();
    expect(getByTestId("room-back-button")).toBeTruthy();
  });

  it("explains when device-key registration is taking unusually long", () => {
    mockCryptoState.isReady = false;
    mockCryptoState.deviceKeyStatus = "registering";
    mockCryptoState.isDeviceKeyRegistrationSlow = true;

    const { getByTestId, getByText } = render(<RoomScreen />);

    expect(getByTestId("room-loading")).toBeTruthy();
    expect(
      getByText(
        "Still registering your device key. Check your connection; encrypted rooms stay closed until it completes.",
      ),
    ).toBeTruthy();
    expect(socketEmits("join-room")).toHaveLength(0);
  });

  it("waits for delayed secure-storage hydration before decrypting persisted history", async () => {
    let resolveLoad!: () => void;
    const restoredKey = new Uint8Array(32).fill(9);
    mockGetRoomKey.mockReturnValue(null);
    mockLoadRoomKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveLoad = () => {
          mockGetRoomKey.mockReturnValue(restoredKey);
          resolve();
        };
      }),
    );
    mockDecryptMessage.mockReturnValue("restored plaintext");
    const view = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [
          {
            id: "persisted-message",
            userId: "user-ada",
            username: "Ada",
            type: "text",
            ciphertext: "ciphertext",
            nonce: "nonce",
          },
        ],
        users: [{ userId: "user-ben", username: "Ben" }],
      });
    });

    expect(view.getByTestId("room-loading")).toBeTruthy();
    expect(mockDecryptMessage).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });

    expect(view.queryByTestId("room-loading")).toBeNull();
    expect(mockDecryptMessage).toHaveBeenCalledWith(
      "ciphertext",
      "nonce",
      "room-42",
    );
  });

  it("lets a room creator confirm and ban another member", async () => {
    const { getByLabelText, getByTestId, getByText } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [
          { userId: "user-ben", username: "Ben" },
          { userId: "user-ada", username: "Ada" },
        ],
        canModerate: true,
      });
    });
    fireEvent.press(getByTestId("room-users-button"));

    expect(getByText("Room moderator controls")).toBeTruthy();
    expect(getByTestId("room-member-list").props.nestedScrollEnabled).toBe(true);
    expect(getByText("Ada").props.style.fontSize).toBeCloseTo(19.6);
    fireEvent.press(getByLabelText("Ban Ada from this room"));

    const confirmationButtons = alertSpy.mock.calls.at(-1)?.[2];
    const confirmButton = confirmationButtons?.find(
      (button: { text?: string }) => button.text === "Ban",
    );
    await act(async () => {
      confirmButton?.onPress?.();
    });

    expect(mockGetToken).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:5000/api/moderation/room-42/ban",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer clerk-token",
        }),
        body: JSON.stringify({ userId: "user-ada" }),
      }),
    );
  });

  it("keeps the exact ban explanation visible until explicit return", () => {
    const { getByTestId, getByText, queryByText } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("error")?.({ code: "ROOM_BANNED" });
    });

    expect(getByTestId("banned-room")).toBeTruthy();
    expect(getByText("Banned from room")).toBeTruthy();
    expect(
      getByText("A room moderator has banned you from this room."),
    ).toBeTruthy();
    expect(queryByText("0 people")).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    fireEvent.press(getByTestId("return-to-room-list-button"));
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)");
  });

  it("shows the persistent explanation when the current user is banned", () => {
    const { getByTestId } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("kicked")?.({
        roomId: "room-42",
        userId: "user-ben",
        banned: true,
      });
    });

    expect(getByTestId("banned-room")).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("ignores kick events targeting another user", () => {
    const { queryByTestId } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("kicked")?.({
        roomId: "room-42",
        userId: "user-other",
        banned: true,
      });
    });

    expect(queryByTestId("banned-room")).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("keeps ordinary kicks distinct from bans", () => {
    const { queryByTestId } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("kicked")?.({
        roomId: "room-42",
        userId: "user-ben",
      });
    });

    expect(queryByTestId("banned-room")).toBeNull();
    expect(alertSpy).toHaveBeenCalledWith(
      "Removed",
      "You have been removed from this room.",
      expect.any(Array),
    );
  });

  it("returns from an active room directly to the room list", () => {
    const { getByTestId } = render(<RoomScreen />);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [],
      });
    });

    fireEvent.press(getByTestId("room-back-button"));

    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)");
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it("blocks joining and offers recovery while the room key is only in memory", async () => {
    mockRoomKeyPersistenceFailures.set("room-42", {
      roomId: "room-42",
      message: "Keep this room open and retry before sending messages.",
    });
    const { getByTestId, getByText, queryByPlaceholderText } = render(<RoomScreen />);

    expect(getByTestId("room-key-storage-warning")).toBeTruthy();
    expect(getByText("Encryption key not saved")).toBeTruthy();
    expect(queryByPlaceholderText("Message…")).toBeNull();
    expect(mockHandlers.has("room-joined")).toBe(false);
    expect(mockSocket.emit).not.toHaveBeenCalledWith(
      "join-room",
      expect.anything(),
    );

    await act(async () => {
      fireEvent.press(getByTestId("retry-room-key-save-button"));
    });

    expect(mockRetryRoomKeyPersistence).toHaveBeenCalledWith("room-42");
  });

  it("still opens the room when saved-key hydration rejects instead of waiting forever", async () => {
    // Reproduces the published-build hang seen on a phone: the secure-store
    // read threw, the join waited on that promise, and "Opening room…" never
    // went away.
    mockGetRoomKey.mockReturnValue(null);
    mockLoadRoomKey.mockRejectedValueOnce(
      new Error("Invalid key provided to SecureStore."),
    );
    const warnMock = jest.spyOn(console, "warn").mockImplementation();
    const view = render(<RoomScreen />);

    await act(async () => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ben", username: "Ben" }],
      });
    });

    expect(view.queryByTestId("room-loading")).toBeNull();
    expect(view.getByTestId("room-back-button")).toBeTruthy();
    expect(warnMock).toHaveBeenCalledWith(
      "Room key hydration failed",
      "Invalid key provided to SecureStore.",
    );
    warnMock.mockRestore();
  });

  it("explains an unreadable saved key and offers a read retry", async () => {
    mockGetRoomKey.mockReturnValue(null);
    mockRoomKeyPersistenceFailures.set("room-42", {
      roomId: "room-42",
      kind: "load",
      message: "This device could not read its saved encryption keys.",
    });
    const { getByTestId, getByText, queryByTestId } = render(<RoomScreen />);

    expect(getByTestId("room-key-storage-warning")).toBeTruthy();
    expect(getByText("Saved encryption key could not be read")).toBeTruthy();
    expect(
      getByText("This device could not read its saved encryption keys."),
    ).toBeTruthy();
    expect(getByText("Retry reading key")).toBeTruthy();
    expect(queryByTestId("room-loading")).toBeNull();
    expect(mockSocket.emit).not.toHaveBeenCalledWith(
      "join-room",
      expect.anything(),
    );

    await act(async () => {
      fireEvent.press(getByTestId("retry-room-key-save-button"));
    });

    expect(mockRetryRoomKeyPersistence).toHaveBeenCalledWith("room-42");
  });

  it("leaves and clears an active room if key persistence later fails", () => {
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [{ id: "secret", content: "shared", type: "text" }],
        users: [{ userId: "user-ben", username: "Ben" }],
      });
    });

    act(() => {
      mockRoomKeyPersistenceFailures.set("room-42", {
        roomId: "room-42",
        message: "Retry before continuing.",
      });
      view.rerender(<RoomScreen />);
    });

    expect(view.getByTestId("room-key-storage-warning")).toBeTruthy();
    expect(view.queryByPlaceholderText("Message…")).toBeNull();
    expect(mockSocket.emit).toHaveBeenCalledWith("leave-room", {
      roomId: "room-42",
    });
  });
});

describe("room device-key registration ordering", () => {
  beforeEach(() => {
    resetRoomMocks();
  });

  it("does not join an encrypted room until the device key is registered", () => {
    mockCryptoState.isReady = false;
    const view = render(<RoomScreen />);

    expect(socketEmits("join-room")).toHaveLength(0);
    expect(view.getByTestId("room-loading")).toBeTruthy();

    mockCryptoState.isReady = true;
    view.rerender(<RoomScreen />);

    expect(socketEmits("join-room")).toHaveLength(1);
  });

  it("leaves during a device-key reset and re-joins only once the replacement key is confirmed", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "cipher", nonceB64: "nonce" });
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({ messages: [], users: [], canModerate: true });
    });
    expect(view.queryByTestId("room-loading")).toBeNull();
    expect(socketEmits("join-room")).toHaveLength(1);

    // The reset swaps the key locally; the server has not confirmed it yet.
    mockCryptoState.isReady = false;
    mockCryptoState.publicKeyB64 = "rotated-key";
    view.rerender(<RoomScreen />);

    expect(socketEmits("leave-room")).toEqual([["leave-room", { roomId: "room-42" }]]);
    expect(socketEmits("join-room")).toHaveLength(1);
    expect(view.getByTestId("room-loading")).toBeTruthy();

    // Registration confirmed: the room is re-joined under the new key and, as
    // creator, this device re-sends envelopes signed with that key.
    mockCryptoState.isReady = true;
    view.rerender(<RoomScreen />);
    expect(socketEmits("join-room")).toHaveLength(2);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ada", username: "Ada", publicKey: "ada-key" }],
        canModerate: true,
      });
    });
    expect(view.queryByTestId("room-loading")).toBeNull();
    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "ada-key");
    expect(socketEmits("room-key-envelope")).toEqual([
      [
        "room-key-envelope",
        {
          roomId: "room-42",
          targetUserId: "user-ada",
          senderPublicKey: "rotated-key",
          ciphertext: "cipher",
          nonce: "nonce",
        },
      ],
    ]);
  });

  it("sends a fresh envelope when a member re-joins with a new device key", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "cipher-2", nonceB64: "nonce-2" });
    render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({ messages: [], users: [], canModerate: true });
    });

    act(() => {
      mockHandlers.get("user-joined")?.({
        userId: "user-ada",
        username: "Ada",
        publicKey: "ada-new-key",
        message: {
          id: "system-join",
          userId: "system",
          username: "System",
          type: "system",
          content: "Ada joined",
          timestamp: 1,
        },
      });
    });

    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "ada-new-key");
    expect(socketEmits("room-key-envelope")).toEqual([
      [
        "room-key-envelope",
        expect.objectContaining({
          targetUserId: "user-ada",
          senderPublicKey: "public-key",
          ciphertext: "cipher-2",
          nonce: "nonce-2",
        }),
      ],
    ]);
  });

  it("sends a fresh envelope when a member's device key changes while another of their sessions stays joined", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "cipher-3", nonceB64: "nonce-3" });
    render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ada", username: "Ada", publicKey: "ada-key" }],
        canModerate: true,
      });
    });
    mockSocket.emit.mockClear();
    mockEncryptRoomKey.mockClear();
    const onUserKeyChanged = mockHandlers.get("user-key-changed");
    expect(onUserKeyChanged).toBeDefined();

    // Notices for other rooms are ignored; a notice about this device's own
    // account means another session took over the key, never an envelope.
    act(() => {
      onUserKeyChanged?.({ roomId: "room-99", userId: "user-ada", publicKey: "ada-new-key" });
      onUserKeyChanged?.({ roomId: "room-42", userId: "user-ben", publicKey: "public-key" });
    });
    expect(socketEmits("room-key-envelope")).toHaveLength(0);
    expect(mockMarkDeviceKeySuperseded).not.toHaveBeenCalled();

    act(() => {
      onUserKeyChanged?.({
        roomId: "room-42",
        userId: "user-ada",
        username: "Ada",
        publicKey: "ada-new-key",
      });
    });
    expect(mockEncryptRoomKey).toHaveBeenCalledTimes(1);
    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "ada-new-key");
    expect(socketEmits("room-key-envelope")).toEqual([
      [
        "room-key-envelope",
        {
          roomId: "room-42",
          targetUserId: "user-ada",
          senderPublicKey: "public-key",
          ciphertext: "cipher-3",
          nonce: "nonce-3",
        },
      ],
    ]);
  });

  it("closes the room when the join roster shows another device's key registered for this account", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "handover-cipher", nonceB64: "handover-nonce" });
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [
          { userId: "user-ada", username: "Ada", publicKey: "ada-key" },
          { userId: "user-ben", username: "Ben", publicKey: "laptop-key" },
        ],
        canModerate: true,
      });
    });

    // The server's key for this account is authoritative: rooms never open
    // under a key the server no longer advertises. As the creator holding the
    // room key, this session first hands the key to the account's new key.
    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "laptop-key");
    expect(socketEmits("room-key-envelope")).toEqual([
      [
        "room-key-envelope",
        {
          roomId: "room-42",
          targetUserId: "user-ben",
          senderPublicKey: "public-key",
          ciphertext: "handover-cipher",
          nonce: "handover-nonce",
        },
      ],
    ]);
    expect(mockMarkDeviceKeySuperseded).toHaveBeenCalledWith("laptop-key");
    expect(mockSocket.emit.mock.calls.findIndex(([name]) => name === "room-key-envelope")).toBeLessThan(
      mockMarkDeviceKeySuperseded.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(view.getByTestId("room-loading")).toBeTruthy();

    // The context reports the conflict; the screen explains and links to Profile.
    mockCryptoState.isReady = false;
    mockCryptoState.deviceKeyStatus = "superseded";
    view.rerender(<RoomScreen />);
    expect(socketEmits("leave-room")).toEqual([["leave-room", { roomId: "room-42" }]]);
    expect(view.getByTestId("room-key-superseded")).toBeTruthy();
    expect(view.getByText("Encryption key replaced")).toBeTruthy();
    expect(view.queryByTestId("room-loading")).toBeNull();
    fireEvent.press(view.getByTestId("room-key-superseded-profile"));
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/profile");
  });

  it("opens the room normally when the roster shows this device's own key or none", () => {
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [
          { userId: "user-ben", username: "Ben", publicKey: "public-key" },
          { userId: "user-ada", username: "Ada" },
        ],
        canModerate: false,
      });
    });
    expect(mockMarkDeviceKeySuperseded).not.toHaveBeenCalled();
    expect(view.queryByTestId("room-loading")).toBeNull();
  });

  it("hands the room key to the account's new key before closing when another session registers it mid-conversation", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "handover-cipher", nonceB64: "handover-nonce" });
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({ messages: [], users: [], canModerate: true });
    });
    expect(view.queryByTestId("room-loading")).toBeNull();
    mockSocket.emit.mockClear();

    act(() => {
      mockHandlers.get("user-key-changed")?.({
        roomId: "room-42",
        userId: "user-ben",
        username: "Ben",
        publicKey: "laptop-key",
      });
    });
    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "laptop-key");
    expect(socketEmits("room-key-envelope")).toEqual([
      [
        "room-key-envelope",
        {
          roomId: "room-42",
          targetUserId: "user-ben",
          senderPublicKey: "public-key",
          ciphertext: "handover-cipher",
          nonce: "handover-nonce",
        },
      ],
    ]);
    expect(mockMarkDeviceKeySuperseded).toHaveBeenCalledWith("laptop-key");
  });

  it("does not hand over room keys it is not the creator of when its key is superseded", () => {
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "handover-cipher", nonceB64: "handover-nonce" });
    const view = render(<RoomScreen />);
    act(() => {
      mockHandlers.get("room-joined")?.({ messages: [], users: [], canModerate: false });
    });
    expect(view.queryByTestId("room-loading")).toBeNull();

    act(() => {
      mockHandlers.get("user-key-changed")?.({
        roomId: "room-42",
        userId: "user-ben",
        username: "Ben",
        publicKey: "laptop-key",
      });
    });
    expect(mockEncryptRoomKey).not.toHaveBeenCalled();
    expect(socketEmits("room-key-envelope")).toHaveLength(0);
    expect(mockMarkDeviceKeySuperseded).toHaveBeenCalledWith("laptop-key");

    // The same holds when the mismatch shows up in a join roster.
    mockMarkDeviceKeySuperseded.mockClear();
    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ben", username: "Ben", publicKey: "laptop-key" }],
        canModerate: false,
      });
    });
    expect(socketEmits("room-key-envelope")).toHaveLength(0);
    expect(mockMarkDeviceKeySuperseded).toHaveBeenCalledWith("laptop-key");
  });

  it("waits for the saved room key to hydrate before handing it over on a mismatched join", async () => {
    let resolveLoad!: () => void;
    mockGetRoomKey.mockReturnValue(null);
    mockLoadRoomKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveLoad = () => {
          mockGetRoomKey.mockReturnValue(defaultRoomKey);
          resolve();
        };
      }),
    );
    mockEncryptRoomKey.mockReturnValue({ ciphertextB64: "handover-cipher", nonceB64: "handover-nonce" });
    render(<RoomScreen />);

    act(() => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ben", username: "Ben", publicKey: "laptop-key" }],
        canModerate: true,
      });
    });
    expect(socketEmits("room-key-envelope")).toHaveLength(0);
    expect(mockMarkDeviceKeySuperseded).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
    expect(mockEncryptRoomKey).toHaveBeenCalledWith(defaultRoomKey, "laptop-key");
    expect(socketEmits("room-key-envelope")).toHaveLength(1);
    expect(socketEmits("leave-room")).toHaveLength(0);
    expect(mockMarkDeviceKeySuperseded).toHaveBeenCalledWith("laptop-key");
  });

  it("recovers a room it created from an envelope handed over by its own account's previous key", async () => {
    const handedOverKey = new Uint8Array(32).fill(5);
    mockGetRoomKey.mockReturnValue(null);
    mockSetRoomKey.mockImplementation(async (_roomId: string, key: Uint8Array) => {
      mockGetRoomKey.mockReturnValue(key);
    });
    mockDecryptRoomKeyEnvelope.mockImplementation((_ciphertext: string, _nonce: string, sender: string) =>
      sender === "old-phone-key" ? handedOverKey : null,
    );
    const view = render(<RoomScreen />);

    // The fresh device took over the registration; the roster already shows
    // its key, and no stored envelope exists for the creator account.
    await act(async () => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [{ userId: "user-ben", username: "Ben", publicKey: "public-key" }],
        canModerate: true,
        keyEnvelope: null,
      });
    });
    expect(mockMarkDeviceKeySuperseded).not.toHaveBeenCalled();
    expect(view.getByTestId("room-key-waiting")).toBeTruthy();
    expect(
      view.getByText(/only another signed-in device or session of yours that still holds the key/),
    ).toBeTruthy();
    expect(view.getByTestId("room-composer-input").props.editable).toBe(false);

    await act(async () => {
      mockHandlers.get("room-key-envelope")?.({
        roomId: "room-42",
        senderPublicKey: "old-phone-key",
        ciphertext: "handover-cipher",
        nonce: "handover-nonce",
      });
    });
    expect(mockDecryptRoomKeyEnvelope).toHaveBeenCalledWith(
      "handover-cipher",
      "handover-nonce",
      "old-phone-key",
    );
    expect(mockSetRoomKey).toHaveBeenCalledWith("room-42", handedOverKey);
    expect(view.queryByTestId("room-key-waiting")).toBeNull();
    expect(view.getByTestId("room-composer-input").props.editable).toBe(true);
  });

  it("explains that the room key is pending until an envelope for the new device key arrives", async () => {
    const freshKey = new Uint8Array(32).fill(9);
    mockGetRoomKey.mockReturnValue(null);
    mockSetRoomKey.mockImplementation(async (_roomId: string, key: Uint8Array) => {
      mockGetRoomKey.mockReturnValue(key);
    });
    // The stored envelope was encrypted to the previous device key and cannot
    // be opened; only the creator's fresh envelope yields the room key.
    mockDecryptRoomKeyEnvelope.mockImplementation((ciphertext: string) =>
      ciphertext === "fresh-cipher" ? freshKey : null,
    );
    const view = render(<RoomScreen />);

    await act(async () => {
      mockHandlers.get("room-joined")?.({
        messages: [],
        users: [],
        keyEnvelope: {
          senderPublicKey: "creator-key",
          ciphertext: "stale-cipher",
          nonce: "stale-nonce",
        },
      });
    });

    expect(view.queryByTestId("room-loading")).toBeNull();
    expect(view.getByTestId("room-key-waiting")).toBeTruthy();
    expect(view.getByText("Waiting for this room's encryption key")).toBeTruthy();
    expect(view.getByTestId("room-composer-input").props.editable).toBe(false);
    expect(mockSetRoomKey).not.toHaveBeenCalled();

    await act(async () => {
      mockHandlers.get("room-key-envelope")?.({
        roomId: "room-42",
        senderPublicKey: "creator-key",
        ciphertext: "fresh-cipher",
        nonce: "fresh-nonce",
      });
    });

    expect(mockSetRoomKey).toHaveBeenCalledWith("room-42", freshKey);
    expect(view.queryByTestId("room-key-waiting")).toBeNull();
    expect(view.getByTestId("room-composer-input").props.editable).toBe(true);
  });
});
