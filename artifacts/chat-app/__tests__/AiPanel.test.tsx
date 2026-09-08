import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import SandboxScreen, {
  prepareWebSandboxHtml,
} from "../app/sandbox/[roomId]";

const mockGetToken = jest.fn();
const mockUseAuth = jest.fn();
const mockRetryRoomKeyPersistence = jest.fn();
const mockRoomKeyPersistenceFailures = new Map<
  string,
  { roomId: string; message: string }
>();

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    roomId: "room-42",
    roomName: "Compiler room",
  }),
  useRouter: () => ({ back: jest.fn() }),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    username: "Ada",
    avatarEmoji: "👩‍💻",
  }),
}));

jest.mock("@/contexts/CryptoContext", () => ({
  useCrypto: () => ({
    getRoomKey: jest.fn(() => new Uint8Array(32).fill(7)),
    loadRoomKey: jest.fn(async () => undefined),
    roomKeyPersistenceFailures: mockRoomKeyPersistenceFailures,
    retryRoomKeyPersistence: mockRetryRoomKeyPersistence,
  }),
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    card: "#171B24",
    border: "#343D4C",
    foreground: "#F4F6FA",
    mutedForeground: "#a5b4fc",
    accent: "#5AA5FA",
    destructive: "#ef4444",
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0 }),
}));

jest.mock("@expo/vector-icons", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Feather: ({ name }: { name: string }) =>
      mockReact.createElement(RN.Text, null, name),
  };
});

jest.mock("react-native-webview", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return function MockWebView({ source }: { source: unknown }) {
    return mockReact.createElement(
      RN.Text,
      { testID: "sandbox-webview" },
      JSON.stringify(source),
    );
  };
});

describe("sandbox assistant host", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "api.example.test";
    mockGetToken.mockReset().mockResolvedValue("clerk-token");
    mockRetryRoomKeyPersistence.mockReset().mockResolvedValue(true);
    mockRoomKeyPersistenceFailures.clear();
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isLoaded: true,
      isSignedIn: true,
    });
  });

  it("blocks a signed-out user before the assistant WebView is requested", async () => {
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isLoaded: true,
      isSignedIn: false,
    });
    const { findByText, queryByTestId } = render(<SandboxScreen />);

    expect(
      await findByText("You need to sign in before opening the sandbox."),
    ).toBeTruthy();
    expect(queryByTestId("sandbox-webview")).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("loads the room-scoped assistant with a Clerk authorization header", async () => {
    const { findByTestId } = render(<SandboxScreen />);
    const webView = await findByTestId("sandbox-webview");
    const source = JSON.parse(webView.props.children);

    expect(source).toEqual({
      uri: "https://api.example.test/api/rooms/sandbox?roomId=room-42&roomName=Compiler%20room",
      headers: {
        Authorization: "Bearer clerk-token",
      },
    });
  });

  it("blocks direct sandbox routes before requesting shared room resources", async () => {
    mockRoomKeyPersistenceFailures.set("room-42", {
      roomId: "room-42",
      message: "Retry before continuing.",
    });
    const { findByTestId, queryByTestId } = render(<SandboxScreen />);

    expect(await findByTestId("sandbox-room-key-storage-block")).toBeTruthy();
    expect(queryByTestId("sandbox-webview")).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("keeps the assistant WebView closed when a signed-in session has no token", async () => {
    mockGetToken.mockResolvedValue(null);
    const { findByText, queryByTestId } = render(<SandboxScreen />);

    await waitFor(() =>
      expect(queryByTestId("sandbox-webview")).toBeNull(),
    );
    expect(
      await findByText("Your signed-in session could not be verified. Please sign in again."),
    ).toBeTruthy();
  });

  it("points browser sandbox scripts and Socket.IO at the API origin", () => {
    const document = prepareWebSandboxHtml(
      '<script src="/api/socket-client.js"></script><script>const socket=io({path:"/api/socket.io"})</script>',
      "https://api.example.test",
    );

    expect(document).toContain(
      '<script src="https://api.example.test/api/socket-client.js"></script>',
    );
    expect(document).toContain(
      'io("https://api.example.test",{path:"/api/socket.io"})',
    );
  });
});
