import React from "react";
import { act, render } from "@testing-library/react-native";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import ChatsScreen from "../app/(tabs)/index";

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
const mockFetch = jest.fn();

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
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

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ ...mockInsets }),
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: jest.fn().mockResolvedValue("token") }),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ username: "Ada" }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1.4,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    destructive: "#ef4444",
    radius: 10,
  }),
}));

jest.mock("@/components/RoomCard", () => () => null);

describe("home screen", () => {
  afterEach(async () => {
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("shows the accessible greeting", async () => {
    const { getByText } = render(<ChatsScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    const greeting = getByText("welcome back");

    expect(greeting.props.accessibilityRole).toBe("header");
    expect(greeting.props.role).toBe("heading");
    expect(greeting.props["aria-level"]).toBe(2);
    expect(getByText("Hi, Ada")).toBeTruthy();
  });

  it("applies the selected scale to the home headings", async () => {
    const { getByText } = render(<ChatsScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getByText("RealtimeAlgoChatApp").props.style.fontSize).toBeCloseTo(42);
    expect(getByText("welcome back").props.style.fontSize).toBeCloseTo(33.6);
  });

  it("allows an intentional console error only when its full call is expected", () => {
    expectConsoleError("Expected test error", { source: "home-test" });

    console.error("Expected test error", { source: "home-test" });
  });
});

describe("home screen tab bar reservation", () => {
  const originalPlatform = Platform.OS;
  const originalFetch = globalThis.fetch;
  // Breathing room below the last room card on top of the tab bar height, in
  // points. The list reserved a flat 90pt over the safe-area inset before it
  // measured the bar, so with the default bar (49pt + inset on native, 84pt on
  // web) the spacing must come out unchanged.
  const NATIVE_BREATHING_ROOM = 41;
  const WEB_BREATHING_ROOM = 6;

  beforeEach(() => {
    mockInsets.top = 0;
    mockInsets.bottom = 0;
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        rooms: [{ id: "room-1", name: "general", userCount: 2, createdAt: 1 }],
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    globalThis.fetch = originalFetch;
  });

  async function renderRooms(ui: React.ReactElement) {
    const view = render(ui);
    // The list only mounts once the first room fetch has resolved.
    await view.findByTestId("chats-list");
    return view;
  }

  function listPaddingBottom(view: {
    getByTestId: (testID: string) => { props: Record<string, unknown> };
  }) {
    const style = view.getByTestId("chats-list").props.contentContainerStyle as StyleProp<ViewStyle>;
    return StyleSheet.flatten(style).paddingBottom;
  }

  it("reserves the measured tab bar height below the last room", async () => {
    // The classic tab navigator publishes its measured bar height (bottom
    // inset included) through this context; the bar overlays the screen (it
    // is see-through, but still dims and blocks whatever scrolls under it), so
    // the end of the list must clear it.
    // A bar taller than the default 49pt + inset (scaled labels, for
    // instance) is exactly the case the former flat `insets.bottom + 90`
    // reservation could not follow.
    mockInsets.bottom = 34;
    const view = await renderRooms(
      <BottomTabBarHeightContext.Provider value={96}>
        <ChatsScreen />
      </BottomTabBarHeightContext.Provider>,
    );

    expect(listPaddingBottom(view)).toBe(96 + NATIVE_BREATHING_ROOM);
  });

  it("tracks the tab bar height as the navigator re-measures it", async () => {
    const view = await renderRooms(
      <BottomTabBarHeightContext.Provider value={49}>
        <ChatsScreen />
      </BottomTabBarHeightContext.Provider>,
    );
    expect(listPaddingBottom(view)).toBe(49 + NATIVE_BREATHING_ROOM);

    // A taller bar (scaled labels, three-button navigation) must move the
    // last row up with it rather than hide behind a fixed reservation.
    view.rerender(
      <BottomTabBarHeightContext.Provider value={120}>
        <ChatsScreen />
      </BottomTabBarHeightContext.Provider>,
    );
    expect(listPaddingBottom(view)).toBe(120 + NATIVE_BREATHING_ROOM);
  });

  it("falls back to the safe-area inset when no tab bar height is published", async () => {
    // Native iOS 26 tabs (and a screen rendered outside the navigator) publish
    // no measured height; the safe-area inset already covers what the system
    // draws at the bottom.
    mockInsets.bottom = 34;
    const view = await renderRooms(<ChatsScreen />);

    expect(listPaddingBottom(view)).toBe(34 + NATIVE_BREATHING_ROOM);
  });

  it("keeps the spacing it had with the default native bar", async () => {
    // The default classic bar measures 49pt plus the bottom inset, which is
    // exactly what the former `insets.bottom + 90` reservation assumed.
    mockInsets.bottom = 34;
    const view = await renderRooms(
      <BottomTabBarHeightContext.Provider value={49 + 34}>
        <ChatsScreen />
      </BottomTabBarHeightContext.Provider>,
    );

    expect(listPaddingBottom(view)).toBe(34 + 90);
  });

  it("keeps the spacing it had with the default web bar", async () => {
    // The web layout pins the bar to 84pt and has no bottom inset, so the
    // former 90pt reservation left 6pt beyond the bar.
    Platform.OS = "web";
    const view = await renderRooms(
      <BottomTabBarHeightContext.Provider value={84}>
        <ChatsScreen />
      </BottomTabBarHeightContext.Provider>,
    );

    expect(listPaddingBottom(view)).toBe(84 + WEB_BREATHING_ROOM);
    expect(listPaddingBottom(view)).toBe(90);
  });
});
