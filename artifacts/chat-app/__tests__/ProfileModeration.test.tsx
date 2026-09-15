import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import ProfileScreen from "../app/(tabs)/profile";
import { onTestPlatform } from "../test-utils/platform";

const mockUseApp = jest.fn();
const mockUseAccessibility = jest.fn();
const mockGetToken = jest.fn();
const mockFetch = jest.fn();
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useAccessibility: () => mockUseAccessibility(),
  useFontScale: () => mockUseAccessibility().fontScale,
}));

jest.mock("@/contexts/SocketContext", () => ({
  useSocket: () => ({ isConnected: true, connectionError: null }),
}));

jest.mock("@/contexts/CryptoContext", () => ({
  useCrypto: () => ({
    deviceKeyStatus: "registered",
    publicKeyB64: "",
    resetDeviceIdentity: jest.fn(),
  }),
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#10131a",
    card: "#171b24",
    border: "#343d4c",
    foreground: "#f4f6fa",
    mutedForeground: "#9aa5b5",
    primary: "#5aa5fa",
    primaryForeground: "#ffffff",
    destructive: "#d9534f",
    online: "#35b46d",
    radius: 12,
  }),
}));

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  NotificationFeedbackType: { Success: "success" },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ ...mockInsets }),
}));

// The real module pulls in expo-router's ESM-only dependencies, which Jest
// cannot parse. The screen only needs the tab bar height context, so provide
// one shared context instance that the tests can populate like the classic
// tab navigator does.
jest.mock("expo-router/js-tabs", () => {
  const mockReact = require("react");
  return {
    BottomTabBarHeightContext: mockReact.createContext(undefined),
  };
});

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

jest.mock("@expo/vector-icons", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Feather: ({ name }: { name: string }) =>
      mockReact.createElement(RN.Text, null, name),
  };
});

const appValue = {
  username: "Ada",
  avatarEmoji: "👩‍💻",
  userId: "user-admin",
  isAdmin: false,
  setUsername: jest.fn(),
  setAvatarEmoji: jest.fn(),
};

const accessibilityValue = {
  highContrast: false,
  fontScale: 1.0 as const,
  reduceMotion: false,
  setHighContrast: jest.fn(),
  setFontScale: jest.fn(),
  setReduceMotion: jest.fn(),
  persistenceError: null,
  retryPersistence: jest.fn(),
};

describe("profile moderation controls", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "api.example.test";
    mockGetToken.mockReset().mockResolvedValue("clerk-token");
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockUseApp.mockReturnValue(appValue);
    mockUseAccessibility.mockReturnValue(accessibilityValue);
  });

  it("lets users change high contrast from accessibility settings", () => {
    const { getByTestId } = render(<ProfileScreen />);

    expect(getByTestId("accessibility-high-contrast-toggle").props.accessibilityState).toEqual({
      checked: false,
    });
    fireEvent.press(getByTestId("accessibility-high-contrast-toggle"));

    expect(accessibilityValue.setHighContrast).toHaveBeenCalledWith(true);
  });

  it("keeps non-sensitive build information available on the profile screen", () => {
    const { getByTestId, getByText } = render(<ProfileScreen />);

    expect(getByTestId("build-identity")).toBeTruthy();
    expect(getByText("BUILD INFORMATION")).toBeTruthy();
    expect(getByText("App version")).toBeTruthy();
    expect(getByText("Build ID")).toBeTruthy();
    expect(getByText("Update created")).toBeTruthy();
    expect(getByText("Runtime")).toBeTruthy();
    expect(getByText("Client")).toBeTruthy();
  });

  it("lets users choose a text size from accessibility settings", () => {
    const { getByTestId } = render(<ProfileScreen />);

    expect(getByTestId("accessibility-font-scale-100").props.accessibilityState).toEqual({
      selected: true,
    });
    fireEvent.press(getByTestId("accessibility-font-scale-140"));

    expect(accessibilityValue.setFontScale).toHaveBeenCalledWith(1.4);
  });

  it("scales profile copy while high contrast and reduced motion remain selected", () => {
    mockUseAccessibility.mockReturnValue({
      ...accessibilityValue,
      highContrast: true,
      fontScale: 1.4,
      reduceMotion: true,
    });
    const { getByText, getByTestId } = render(<ProfileScreen />);

    expect(getByText("Profile").props.style.fontSize).toBeCloseTo(39.2);
    expect(getByTestId("accessibility-high-contrast-toggle").props.accessibilityState).toEqual({
      checked: true,
    });
    expect(getByTestId("accessibility-font-scale-140").props.accessibilityState).toEqual({
      selected: true,
    });
    expect(getByTestId("accessibility-reduced-motion-toggle").props.accessibilityState).toEqual({
      checked: true,
    });
  });

  it("lets users change reduced motion from accessibility settings", () => {
    const { getByTestId } = render(<ProfileScreen />);

    expect(getByTestId("accessibility-reduced-motion-toggle").props.accessibilityState).toEqual({
      checked: false,
    });
    fireEvent.press(getByTestId("accessibility-reduced-motion-toggle"));

    expect(accessibilityValue.setReduceMotion).toHaveBeenCalledWith(true);
  });

  it("does not show account moderation controls to non-administrators", () => {
    const { queryByTestId } = render(<ProfileScreen />);

    expect(queryByTestId("moderation-panel")).toBeNull();
  });

  it("bans an account and reports the completed action to administrators", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const { getByTestId, findByTestId } = render(<ProfileScreen />);

    fireEvent.changeText(getByTestId("moderation-user-id"), "user-target");
    fireEvent.press(getByTestId("ban-account-button"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/ban",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer clerk-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: "user-target" }),
        }),
      ),
    );
    expect((await findByTestId("moderation-feedback")).props.children).toBe(
      "Account user-target is banned and can no longer access RealtimeAlgoChatApp Studio.",
    );
  });

  it("restores an account and reports the completed action to administrators", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const { getByTestId, findByTestId } = render(<ProfileScreen />);

    fireEvent.changeText(getByTestId("moderation-user-id"), "user-target");
    fireEvent.press(getByTestId("restore-account-button"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/ban/user-target",
        expect.objectContaining({
          method: "DELETE",
          headers: { Authorization: "Bearer clerk-token" },
        }),
      ),
    );
    expect((await findByTestId("moderation-feedback")).props.children).toBe(
      "Account user-target has been restored and can access RealtimeAlgoChatApp Studio again.",
    );
  });

  it("does not show account search controls to non-administrators", () => {
    const { queryByTestId } = render(<ProfileScreen />);

    expect(queryByTestId("moderation-search-input")).toBeNull();
  });

  it("lets an administrator find and select an account before banning it", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/search")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                userId: "user-target",
                username: "Grace Hopper",
                avatarEmoji: "🧑‍💻",
                email: "grace@example.test",
                banned: false,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId, findByTestId, getByText } = render(<ProfileScreen />);

    fireEvent.changeText(getByTestId("moderation-search-input"), "grace");
    fireEvent.press(getByTestId("moderation-search-button"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/search?query=grace",
        expect.objectContaining({
          headers: { Authorization: "Bearer clerk-token" },
        }),
      ),
    );

    fireEvent.press(await findByTestId("moderation-search-result-user-target"));

    expect(getByText("Selected: Grace Hopper")).toBeTruthy();
    expect(getByTestId("moderation-user-id").props.value).toBe("user-target");

    fireEvent.press(getByTestId("ban-account-button"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/ban",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "user-target" }),
        }),
      ),
    );
    expect((await findByTestId("moderation-feedback")).props.children).toBe(
      "Account Grace Hopper (user-target) is banned and can no longer access RealtimeAlgoChatApp Studio.",
    );
  });

  it("shows a search error without exposing account data for a short query", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ actions: [] }) });
    const { getByTestId, findByTestId, queryByTestId } = render(<ProfileScreen />);

    fireEvent.changeText(getByTestId("moderation-search-input"), "a");
    fireEvent.press(getByTestId("moderation-search-button"));

    expect((await findByTestId("moderation-search-error")).props.children).toBe(
      "Enter at least 2 characters to search.",
    );
    expect(
      mockFetch.mock.calls.some(([url]: [string]) => url.includes("/api/moderation/search")),
    ).toBe(false);
    expect(queryByTestId("moderation-search-results")).toBeNull();
  });

  it("lets an administrator filter history by an account selected from search results", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/search")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                userId: "user-target",
                username: "Grace Hopper",
                avatarEmoji: "🧑‍💻",
                email: "grace@example.test",
                banned: false,
              },
            ],
          }),
        };
      }
      if (typeof url === "string" && url.includes("targetUserId=user-target")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 4,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return { ok: true, json: async () => ({ actions: [], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId, findByTestId } = render(<ProfileScreen />);

    fireEvent.changeText(getByTestId("moderation-search-input"), "grace");
    fireEvent.press(getByTestId("moderation-search-button"));
    fireEvent.press(await findByTestId("moderation-search-result-user-target"));

    fireEvent.press(await findByTestId("moderation-selected-account-filter-history"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?targetUserId=user-target",
        expect.anything(),
      ),
    );
    expect(await findByTestId("moderation-history-entry-4")).toBeTruthy();
    expect(getByTestId("moderation-history-target-filter").props.value).toBe("user-target");
  });

  it("lets an administrator filter history by tapping an account name in a history row", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("actorUserId=user-admin")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 4,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 4,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId, findByTestId } = render(<ProfileScreen />);

    fireEvent.press(await findByTestId("moderation-history-entry-4-filter-actor"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?actorUserId=user-admin",
        expect.anything(),
      ),
    );
    expect(getByTestId("moderation-history-actor-filter").props.value).toBe("user-admin");
  });

  it("does not show moderation history to non-administrators", async () => {
    const { queryByTestId } = render(<ProfileScreen />);

    expect(queryByTestId("moderation-history-list")).toBeNull();
    expect(
      mockFetch.mock.calls.some(([url]: [string]) => url.includes("/api/moderation/history")),
    ).toBe(false);
  });

  it("loads and displays moderation history for administrators", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 1,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-20T12:00:00.000Z",
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const { findByTestId } = render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history",
        expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
      ),
    );
    const entry = await findByTestId("moderation-history-entry-1");
    expect(entry).toBeTruthy();
  });

  it("lets an administrator filter moderation history by account", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return { ok: true, json: async () => ({ actions: [], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId } = render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history",
        expect.anything(),
      ),
    );

    fireEvent.changeText(getByTestId("moderation-history-target-filter"), "user-target");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?targetUserId=user-target",
        expect.anything(),
      ),
    );
  });

  it("stops filtering after Clear is pressed", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return { ok: true, json: async () => ({ actions: [], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId, findByTestId } = render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history",
        expect.anything(),
      ),
    );

    fireEvent.changeText(getByTestId("moderation-history-target-filter"), "user-target");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?targetUserId=user-target",
        expect.anything(),
      ),
    );

    fireEvent.press(await findByTestId("moderation-history-filter-clear"));

    await waitFor(() => {
      const historyCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => typeof url === "string" && url.includes("/api/moderation/history"),
      );
      expect(historyCalls[historyCalls.length - 1]?.[0]).toBe(
        "https://api.example.test/api/moderation/history",
      );
    });
  });

  it("removes only the cleared field when one of two filters is unset", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return { ok: true, json: async () => ({ actions: [], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId } = render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history",
        expect.anything(),
      ),
    );

    fireEvent.changeText(getByTestId("moderation-history-target-filter"), "user-target");
    fireEvent.changeText(getByTestId("moderation-history-actor-filter"), "admin-ada");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?targetUserId=user-target&actorUserId=admin-ada",
        expect.anything(),
      ),
    );

    fireEvent.changeText(getByTestId("moderation-history-actor-filter"), "");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?targetUserId=user-target",
        expect.anything(),
      ),
    );
  });

  it("lets an administrator load older moderation history entries", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("cursor=1")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 1,
                action: "restore",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-01T12:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 2,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-20T12:00:00.000Z",
              },
            ],
            nextCursor: 1,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const { findByTestId, getByTestId } = render(<ProfileScreen />);

    expect(await findByTestId("moderation-history-entry-2")).toBeTruthy();
    fireEvent.press(getByTestId("moderation-history-load-more"));

    expect(await findByTestId("moderation-history-entry-1")).toBeTruthy();
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.test/api/moderation/history?cursor=1",
        expect.anything(),
      ),
    );
  });

  it("discards a stale load-more response that resolves after filters change", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    let resolveLoadMore: (value: unknown) => void = () => {};
    const loadMorePromise = new Promise((resolve) => {
      resolveLoadMore = resolve;
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("cursor=1")) {
        return loadMorePromise;
      }
      if (typeof url === "string" && url.includes("targetUserId=user-other")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 3,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-other",
                targetUsername: "Other Account",
                targetEmail: null,
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 2,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-20T12:00:00.000Z",
              },
            ],
            nextCursor: 1,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const { findByTestId, getByTestId, queryByTestId } = render(<ProfileScreen />);

    expect(await findByTestId("moderation-history-entry-2")).toBeTruthy();

    fireEvent.press(getByTestId("moderation-history-load-more"));

    fireEvent.changeText(getByTestId("moderation-history-target-filter"), "user-other");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    expect(await findByTestId("moderation-history-entry-3")).toBeTruthy();

    resolveLoadMore({
      ok: true,
      json: async () => ({
        actions: [
          {
            id: 1,
            action: "restore",
            actorUserId: "user-admin",
            actorUsername: "Ada",
            targetUserId: "user-target",
            targetUsername: "Grace Hopper",
            targetEmail: "grace@example.test",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryByTestId("moderation-history-entry-1")).toBeNull();
    expect(getByTestId("moderation-history-entry-3")).toBeTruthy();
  });

  it("keeps Load more enabled and usable after filters change while an older load-more request is still pending", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    const hangingLoadMore = new Promise(() => {
      /* never resolves -- represents the superseded, in-flight request */
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url !== "string") return { ok: true, json: async () => ({ ok: true }) };
      if (url.includes("targetUserId=user-other") && url.includes("cursor=9")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 8,
                action: "restore",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-other",
                targetUsername: "Other Account",
                targetEmail: null,
                createdAt: "2026-08-10T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }
      if (url.includes("targetUserId=user-other")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 5,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-other",
                targetUsername: "Other Account",
                targetEmail: null,
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
            nextCursor: 9,
          }),
        };
      }
      if (url.includes("cursor=1")) {
        return hangingLoadMore;
      }
      if (url.includes("/api/moderation/history")) {
        return {
          ok: true,
          json: async () => ({
            actions: [
              {
                id: 2,
                action: "ban",
                actorUserId: "user-admin",
                actorUsername: "Ada",
                targetUserId: "user-target",
                targetUsername: "Grace Hopper",
                targetEmail: "grace@example.test",
                createdAt: "2026-08-20T12:00:00.000Z",
              },
            ],
            nextCursor: 1,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const { findByTestId, getByTestId } = render(<ProfileScreen />);

    expect(await findByTestId("moderation-history-entry-2")).toBeTruthy();

    // Start a load-more request that will never resolve in this test --
    // it stands in for the superseded, still-in-flight request.
    fireEvent.press(getByTestId("moderation-history-load-more"));

    fireEvent.changeText(getByTestId("moderation-history-target-filter"), "user-other");
    fireEvent.press(getByTestId("moderation-history-filter-apply"));

    expect(await findByTestId("moderation-history-entry-5")).toBeTruthy();

    const loadMoreButton = getByTestId("moderation-history-load-more");
    expect(loadMoreButton.props.accessibilityState?.disabled).not.toBe(true);

    fireEvent.press(loadMoreButton);

    expect(await findByTestId("moderation-history-entry-8")).toBeTruthy();
  });

  it("refreshes moderation history after a ban completes", async () => {
    mockUseApp.mockReturnValue({ ...appValue, isAdmin: true });
    let historyCallCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/moderation/history")) {
        historyCallCount += 1;
        return { ok: true, json: async () => ({ actions: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { getByTestId } = render(<ProfileScreen />);

    await waitFor(() => expect(historyCallCount).toBe(1));

    fireEvent.changeText(getByTestId("moderation-user-id"), "user-target");
    fireEvent.press(getByTestId("ban-account-button"));

    await waitFor(() => expect(historyCallCount).toBe(2));
  });
});

describe("profile layout under the tab bar and keyboard", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "api.example.test";
    mockGetToken.mockReset().mockResolvedValue("clerk-token");
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockUseApp.mockReturnValue(appValue);
    mockUseAccessibility.mockReturnValue(accessibilityValue);
    mockInsets.top = 0;
    mockInsets.bottom = 0;
  });

  function contentPaddingBottom(view: {
    getByTestId: (testID: string) => { props: Record<string, unknown> };
  }) {
    const style = view.getByTestId("profile-scroll").props.contentContainerStyle as StyleProp<ViewStyle>;
    return StyleSheet.flatten(style).paddingBottom;
  }

  it("reserves the measured tab bar height below the profile content", () => {
    // The classic tab navigator publishes its measured bar height (bottom
    // inset included) through this context; the bar overlays the screen and
    // is opaque on Android and web, so the scroll content must clear it. This
    // suite runs under the iOS and Android Jest projects, so the reservation
    // is checked on the platform where the bar actually hides content.
    mockInsets.bottom = 34;
    const view = render(
      <BottomTabBarHeightContext.Provider value={83}>
        <ProfileScreen />
      </BottomTabBarHeightContext.Provider>,
    );

    expect(contentPaddingBottom(view)).toBe(83 + 24);
  });

  it("tracks the tab bar height as the navigator re-measures it", () => {
    const view = render(
      <BottomTabBarHeightContext.Provider value={49}>
        <ProfileScreen />
      </BottomTabBarHeightContext.Provider>,
    );
    expect(contentPaddingBottom(view)).toBe(49 + 24);

    view.rerender(
      <BottomTabBarHeightContext.Provider value={84}>
        <ProfileScreen />
      </BottomTabBarHeightContext.Provider>,
    );
    expect(contentPaddingBottom(view)).toBe(84 + 24);
  });

  it("falls back to the safe-area inset when no tab bar height is published", () => {
    // Native iOS 26 tabs (and a screen rendered outside the navigator) publish
    // no measured height; the safe-area inset already covers what the system
    // draws at the bottom.
    mockInsets.bottom = 34;
    const view = render(<ProfileScreen />);

    expect(contentPaddingBottom(view)).toBe(34 + 24);
  });

  it("avoids the keyboard with the keyboard-controller padding strategy on every platform", () => {
    const { getByTestId } = render(<ProfileScreen />);

    const avoidingView = getByTestId("profile-keyboard-avoiding-view");
    expect(avoidingView.props.behavior).toBe("padding");
    expect(avoidingView.props.keyboardVerticalOffset).toBe(0);
    expect(getByTestId("profile-scroll").props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("shows the user ID in the platform's monospace face", () => {
    const { getByText } = render(<ProfileScreen />);

    // iOS ships Courier; Android has no such face and must fall back to the
    // system monospace family or the ID renders in the default proportional
    // font. The Android Jest project is what proves the fallback branch.
    expect(StyleSheet.flatten(getByText("user-admin").props.style).fontFamily).toBe(
      onTestPlatform({ ios: "Courier", android: "monospace" }),
    );
  });
});