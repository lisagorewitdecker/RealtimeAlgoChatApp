import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import SetupScreen from "../app/setup";

const mockSetUsername = jest.fn();
const mockReplace = jest.fn();

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@clerk/expo", () => ({
  useClerk: () => ({ signOut: jest.fn() }),
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 16, left: 0, right: 0 }),
}));

jest.mock("@/components/KeyboardAwareScrollViewCompat", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    KeyboardAwareScrollViewCompat: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => mockReact.createElement(RN.ScrollView, props, children),
  };
});

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ setUsername: mockSetUsername }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1.4,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#000000",
    foreground: "#ffffff",
    secondaryForeground: "#ffffff",
    mutedForeground: "#f5f5f5",
    secondary: "#111111",
    muted: "#222222",
    card: "#080808",
    border: "#ffffff",
    primary: "#ffff00",
    primaryForeground: "#000000",
    destructive: "#ff6b6b",
    radius: 10,
  }),
}));

describe("setup large-text reachability", () => {
  beforeEach(() => {
    mockSetUsername.mockReset().mockResolvedValue(undefined);
    mockReplace.mockReset();
  });

  it("keeps the scaled input and submit action in a keyboard-aware scroll view", () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(<SetupScreen />);

    const scroll = getByTestId("setup-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).flexGrow).toBe(1);
    expect(getByPlaceholderText("How should your team know you?").props.style.fontSize)
      .toBeCloseTo(22.4);
    expect(getByText("Enter workspace").props.style.fontSize).toBeCloseTo(22.4);

    fireEvent.changeText(getByPlaceholderText("How should your team know you?"), "Ada");
    expect(getByText("Enter workspace")).toBeTruthy();
  });
});