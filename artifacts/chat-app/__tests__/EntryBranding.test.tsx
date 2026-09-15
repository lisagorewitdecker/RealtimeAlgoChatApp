import React from "react";
import { act, render } from "@testing-library/react-native";
import { StatusBar as NativeStatusBar } from "react-native";
import { StatusBar } from "expo-status-bar";
import SetupScreen from "../app/setup";
import RootLayout from "../app/_layout";

process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_entry_branding";

let mockIsSignedIn = true;

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));

jest.mock("expo-router", () => {
  const mockReact = require("react");
  const RN = require("react-native");
  const Stack = ({ children }: { children: unknown }) =>
    mockReact.createElement(RN.View, null, children);
  Stack.Screen = () => null;
  return {
    Stack,
    useRouter: () => ({ replace: jest.fn() }),
    useSegments: () => [],
  };
});

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));

jest.mock("@expo-google-fonts/inter", () => ({
  Inter_400Regular: "Inter_400Regular",
  Inter_500Medium: "Inter_500Medium",
  Inter_600SemiBold: "Inter_600SemiBold",
  Inter_700Bold: "Inter_700Bold",
  useFonts: () => [true, null],
}));

jest.mock("@clerk/expo", () => ({
  ClerkLoaded: ({ children }: { children: unknown }) => children,
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({
    getToken: jest.fn(),
    isLoaded: true,
    isSignedIn: mockIsSignedIn,
  }),
  useClerk: () => ({ signOut: jest.fn() }),
}));

jest.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: jest.fn(),
  setBaseUrl: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  QueryClient: jest.fn(),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: unknown }) => children,
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: unknown }) => children,
  KeyboardAwareScrollView: ({
    children,
    ...props
  }: {
    children: unknown;
    [key: string]: unknown;
  }) => {
    const RN = require("react-native");
    const mockReact = require("react");
    return mockReact.createElement(RN.ScrollView, props, children);
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: unknown }) => children,
}));

jest.mock("@/contexts/SocketContext", () => ({
  SocketProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("@/contexts/AppContext", () => ({
  AppProvider: ({ children }: { children: unknown }) => children,
  useApp: () => ({
    accessStatus: "banned",
    isReady: true,
    username: "",
  }),
}));

jest.mock("@/lib/clerkTokenCache", () => ({
  clerkTokenCache: {},
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    secondary: "#1e1b4b",
    secondaryForeground: "#c7d2fe",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    destructive: "#ef4444",
    muted: "#242938",
    radius: 10,
  }),
}));

describe("entry-screen branding", () => {
  beforeEach(() => {
    mockIsSignedIn = true;
  });

  it("uses RealtimeAlgoChatApp Studio on the setup screen", async () => {
    const view = render(<SetupScreen />);
    await act(async () => {});

    expect(view.getByText("RealtimeAlgoChatApp Studio")).toBeTruthy();
    expect(view.queryByText("DevAlgoChat Studio")).toBeNull();
    expect(view.queryByText("DevStudio")).toBeNull();
  });

  it("uses RealtimeAlgoChatApp Studio in shared account access messaging", async () => {
    const view = render(<RootLayout />);
    await act(async () => {});

    expect(
      view.getByText(
        "This RealtimeAlgoChatApp Studio account has been banned. You cannot join rooms, calls, or sandboxes.",
      ),
    ).toBeTruthy();
    expect(
      view.queryByText(
        "This DevAlgoChat Studio account has been banned. You cannot join rooms, calls, or sandboxes.",
      ),
    ).toBeNull();
  });

  it("uses RealtimeAlgoChatApp Studio on the unauthenticated access gate", async () => {
    mockIsSignedIn = false;
    const view = render(<RootLayout />);
    await act(async () => {});

    expect(
      view.getByText(
        "Create an account or sign in to open RealtimeAlgoChatApp Studio rooms and sandboxes.",
      ),
    ).toBeTruthy();
    expect(view.queryByText(/DevAlgoChat|DevStudio|ChatSphere/)).toBeNull();
  });

  it("declares light system-bar content over the always-dark palette", async () => {
    // Android draws the status bar over the app and follows the device theme
    // unless told otherwise; on a light-themed device the clock and icons
    // would be dark on the dark background. The root layout pins light
    // content once for every screen.
    const view = render(<RootLayout />);
    await act(async () => {});

    expect(view.UNSAFE_getByType(StatusBar).props.style).toBe("light");
    expect(view.UNSAFE_getByType(NativeStatusBar).props.barStyle).toBe(
      "light-content",
    );
  });

  it("keeps light system-bar content on the Clerk configuration screen", async () => {
    const previousKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const previousManagedKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.VITE_CLERK_PUBLISHABLE_KEY;

    try {
      const view = render(<RootLayout />);
      await act(async () => {});

      expect(view.getByText("Authentication setup needed")).toBeTruthy();
      expect(view.UNSAFE_getByType(StatusBar).props.style).toBe("light");
    } finally {
      if (previousKey === undefined) {
        delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = previousKey;
      }
      if (previousManagedKey === undefined) {
        delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.VITE_CLERK_PUBLISHABLE_KEY = previousManagedKey;
      }
    }
  });

  it("renders an actionable state when Clerk configuration is missing", async () => {
    const previousKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const previousManagedKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.VITE_CLERK_PUBLISHABLE_KEY;

    try {
      const view = render(<RootLayout />);
      await act(async () => {});

      expect(view.getByText("Authentication setup needed")).toBeTruthy();
      expect(
        view.getByText(
          "Authentication setup is incomplete. Ask the project owner to provide the managed Clerk publishable key, then reload the app.",
        ),
      ).toBeTruthy();
    } finally {
      if (previousKey === undefined) {
        delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = previousKey;
      }
      if (previousManagedKey === undefined) {
        delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.VITE_CLERK_PUBLISHABLE_KEY = previousManagedKey;
      }
    }
  });

  it("renders an actionable state when Clerk configuration is malformed", async () => {
    const previousKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "malformed-key";

    try {
      const view = render(<RootLayout />);
      await act(async () => {});

      expect(view.getByText("Authentication setup needed")).toBeTruthy();
      expect(view.getByText(/Clerk publishable key is not valid/)).toBeTruthy();
      expect(view.queryByText("malformed-key")).toBeNull();
    } finally {
      if (previousKey === undefined) {
        delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = previousKey;
      }
    }
  });
});