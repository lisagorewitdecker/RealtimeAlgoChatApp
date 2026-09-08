import React from "react";
import { render } from "@testing-library/react-native";
import CallScreen from "../app/call/[roomId]";

const mockGetToken = jest.fn();
const mockRetryRoomKeyPersistence = jest.fn();
const mockRoomKeyPersistenceFailures = new Map([
  [
    "room-42",
    {
      roomId: "room-42",
      message: "Retry before continuing.",
    },
  ],
]);

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({
    getToken: mockGetToken,
    isLoaded: true,
    isSignedIn: true,
  }),
}));

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    roomId: "room-42",
    roomName: "Compiler room",
  }),
  useRouter: () => ({ back: jest.fn() }),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ userId: "user-ada" }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1.4,
}));

jest.mock("@/contexts/CryptoContext", () => ({
  useCrypto: () => ({
    roomKeyPersistenceFailures: mockRoomKeyPersistenceFailures,
    retryRoomKeyPersistence: mockRetryRoomKeyPersistence,
  }),
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    secondaryForeground: "#f8fafc",
    destructive: "#ef4444",
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0 }),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("react-native-webview", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return function MockWebView() {
    return mockReact.createElement(RN.Text, { testID: "call-webview" });
  };
});

describe("call room-key persistence guard", () => {
  beforeEach(() => {
    mockGetToken.mockReset().mockResolvedValue("clerk-token");
    mockRetryRoomKeyPersistence.mockReset().mockResolvedValue(true);
  });

  it("blocks direct call routes before requesting shared room resources", async () => {
    const { findByTestId, findByText, queryByTestId } = render(<CallScreen />);

    expect(await findByTestId("call-room-key-storage-block")).toBeTruthy();
    expect(queryByTestId("call-webview")).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(await findByTestId("retry-call-room-key-save-button")).toBeTruthy();
    expect((await findByText("Call blocked until the room key is saved")).props.style.fontSize)
      .toBeCloseTo(26.6);
    expect(await findByText("Retry saving key")).toBeTruthy();
  });
});