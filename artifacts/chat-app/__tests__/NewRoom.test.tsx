import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import NewRoomScreen from "../app/new-room";
import { withinKeyboardAwareScrollViewCompat } from "../test-utils/keyboardAwareScrollViewCompatMock";

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
};
const mockGenerateRoomKey = jest.fn();
const mockGetRoomKey = jest.fn();
const mockRetryRoomKeyPersistence = jest.fn();
const mockRoomKeyPersistenceFailures = new Map<
  string,
  { roomId: string; message: string }
>();

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
}));

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The shared stand-in tags its host element so the suite can prove the form
// renders inside the compat component, not merely inside some scroll view.
jest.mock("@/components/KeyboardAwareScrollViewCompat", () =>
  jest.requireActual("../test-utils/keyboardAwareScrollViewCompatMock"),
);

jest.mock("@/contexts/CryptoContext", () => {
  class MockRoomKeyPersistenceError extends Error {
    readonly roomId: string;
    readonly reason: "storage_unavailable" | "identity_changed";

    constructor(
      roomId: string,
      reason: "storage_unavailable" | "identity_changed" = "storage_unavailable",
    ) {
      super("This device could not save the room encryption key.");
      this.name = "RoomKeyPersistenceError";
      this.roomId = roomId;
      this.reason = reason;
    }
  }

  return {
    RoomKeyPersistenceError: MockRoomKeyPersistenceError,
    useCrypto: () => ({
      generateRoomKey: mockGenerateRoomKey,
      getRoomKey: mockGetRoomKey,
      retryRoomKeyPersistence: mockRetryRoomKeyPersistence,
      roomKeyPersistenceFailures: mockRoomKeyPersistenceFailures,
    }),
  };
});

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1.4,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    secondary: "#1e1b4b",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    muted: "#242938",
    destructive: "#ef4444",
    radius: 10,
  }),
}));

describe("new room encryption-key setup", () => {
  let inMemoryKey: Uint8Array | null;

  beforeEach(() => {
    inMemoryKey = null;
    mockRoomKeyPersistenceFailures.clear();
    Object.values(mockRouter).forEach((mock) => mock.mockReset());
    mockGetRoomKey.mockReset().mockImplementation(() => inMemoryKey);
    mockGenerateRoomKey.mockReset().mockImplementation(async (roomId: string) => {
      inMemoryKey = new Uint8Array(32).fill(7);
      mockRoomKeyPersistenceFailures.set(roomId, {
        roomId,
        message: "Keep this room open and retry before sending messages.",
      });
      const { RoomKeyPersistenceError } = require("@/contexts/CryptoContext");
      throw new RoomKeyPersistenceError(roomId);
    });
    mockRetryRoomKeyPersistence.mockReset().mockImplementation(
      async (roomId: string) => {
        mockRoomKeyPersistenceFailures.delete(roomId);
        return true;
      },
    );
  });

  it("renders both room forms and the submit button inside KeyboardAwareScrollViewCompat", () => {
    const view = render(<NewRoomScreen />);

    // The scroll element, each mode's input and the submit button are looked
    // up inside the compat component's host element: a plain ScrollView
    // carrying the same testID and props would pass the prop expectations
    // while phones lose keyboard-aware scrolling on this form. This suite
    // runs under the iOS and Android Jest projects, so both are covered.
    const form = withinKeyboardAwareScrollViewCompat(view);
    const scroll = form.getByTestId("new-room-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.props.keyboardDismissMode).toBe("interactive");
    expect(scroll.props.bottomOffset).toBe(72);
    expect(form.getByTestId("room-name-input")).toBeTruthy();
    expect(form.getByTestId("room-submit-button")).toBeTruthy();

    fireEvent.press(form.getByTestId("new-room-mode-join"));
    expect(form.getByTestId("room-id-input")).toBeTruthy();
    expect(form.getByTestId("room-submit-button")).toBeTruthy();
  });

  it("keeps the room closed until the existing in-memory key is saved", async () => {
    const { getByTestId, getByText } = render(<NewRoomScreen />);
    expect(getByTestId("new-room-scroll").props.keyboardShouldPersistTaps).toBe("handled");
    expect(getByTestId("room-name-input").props.style.fontSize).toBeCloseTo(22.4);
    fireEvent.changeText(getByTestId("room-name-input"), "Design Team");

    await act(async () => {
      fireEvent.press(getByTestId("room-submit-button"));
    });

    expect(mockGenerateRoomKey).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(getByTestId("new-room-key-storage-warning")).toBeTruthy();
    expect(getByText("Room key could not be saved")).toBeTruthy();
    expect(getByText("Retry creating room").props.style.fontSize).toBeCloseTo(22.4);

    const failedRoomId = mockGenerateRoomKey.mock.calls[0]?.[0] as string;
    await act(async () => {
      fireEvent.press(getByTestId("room-submit-button"));
    });

    expect(mockGenerateRoomKey).toHaveBeenCalledTimes(1);
    expect(mockRetryRoomKeyPersistence).toHaveBeenCalledWith(failedRoomId);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/room/${encodeURIComponent(failedRoomId)}?roomName=Design%20Team&create=true`,
    );
  });
});