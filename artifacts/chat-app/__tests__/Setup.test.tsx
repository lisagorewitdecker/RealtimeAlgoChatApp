import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import SetupScreen from "../app/setup";
import { withinKeyboardAwareScrollViewCompat } from "../test-utils/keyboardAwareScrollViewCompatMock";

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

// The shared stand-in tags its host element so the suite can prove the form
// renders inside the compat component, not merely inside some scroll view.
jest.mock("@/components/KeyboardAwareScrollViewCompat", () =>
  jest.requireActual("../test-utils/keyboardAwareScrollViewCompatMock"),
);

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
    const view = render(<SetupScreen />);

    // The scroll element, the input and the submit button are looked up inside
    // the compat component's host element: a plain ScrollView carrying the
    // same testID and props would pass the prop expectations while phones
    // lose keyboard-aware scrolling on this form. This suite runs under the
    // iOS and Android Jest projects, so both platforms are covered.
    const form = withinKeyboardAwareScrollViewCompat(view);
    const scroll = form.getByTestId("setup-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.props.keyboardDismissMode).toBe("interactive");
    expect(scroll.props.bottomOffset).toBe(72);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).flexGrow).toBe(1);
    expect(form.getByPlaceholderText("How should your team know you?").props.style.fontSize)
      .toBeCloseTo(22.4);
    expect(form.getByTestId("setup-submit-button")).toBeTruthy();
    expect(form.getByText("Enter workspace").props.style.fontSize).toBeCloseTo(22.4);

    fireEvent.changeText(form.getByPlaceholderText("How should your team know you?"), "Ada");
    expect(form.getByText("Enter workspace")).toBeTruthy();
  });
});