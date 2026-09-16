import React from "react";
import { render } from "@testing-library/react-native";
import ForgotPasswordScreen from "../app/(auth)/forgot-password";

jest.mock("@clerk/expo", () => ({
  useSignIn: () => ({
    signIn: {
      password: { sendResetCode: jest.fn(), verifyResetCode: jest.fn(), reset: jest.fn() },
    },
    errors: null,
    fetchStatus: "idle",
  }),
}));

jest.mock("expo-router", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Link: ({ children }: { children: unknown }) =>
      mockReact.createElement(RN.Text, null, children),
    useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));

jest.mock("@expo/vector-icons", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Feather: ({ name }: { name: string }) =>
      mockReact.createElement(RN.Text, null, name),
  };
});

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    secondary: "#1e1b4b",
    destructive: "#ef4444",
    radius: 10,
  }),
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

describe("forgot password layout", () => {
  it("avoids the keyboard with the keyboard-controller padding strategy on every platform", () => {
    const { getByTestId, getByPlaceholderText } = render(<ForgotPasswordScreen />);

    // Same strategy as the other keyboard-driven screens: no Android-only
    // "height" behavior, which left the field under the keyboard once the
    // keyboard-controller provider owned the Android insets.
    const avoidingView = getByTestId("forgot-password-keyboard-avoiding-view");
    expect(avoidingView.props.behavior).toBe("padding");
    expect(avoidingView.props.keyboardVerticalOffset).toBe(0);
    expect(getByPlaceholderText("you@example.com")).toBeTruthy();
  });
});
