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
  { roomId: string; message: string }
>();

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
    isReady: true,
    publicKeyB64: "public-key",
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

describe("room ban handling", () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
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
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true }),
    }) as jest.Mock;
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