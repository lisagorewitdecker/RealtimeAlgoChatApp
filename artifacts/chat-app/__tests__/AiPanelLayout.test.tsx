import React from "react";
import { render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import AiPanel from "../components/AiPanel";

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: jest.fn().mockResolvedValue("clerk-token") }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useAccessibility: () => ({ reduceMotion: false }),
  useFontScale: () => 1,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#0d0d1a",
    foreground: "#f8fafc",
    mutedForeground: "#a5b4fc",
    card: "#171B24",
    border: "#343D4C",
    primary: "#6366f1",
    muted: "#242938",
    radius: 10,
  }),
}));

jest.mock("@expo/vector-icons", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Feather: ({ name }: { name: string }) =>
      mockReact.createElement(RN.Text, null, name),
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

describe("AI panel layout", () => {
  it("avoids the keyboard with the keyboard-controller padding strategy on every platform", () => {
    const { getByTestId } = render(<AiPanel roomId="room-42" />);

    // Same strategy as the room screen: keyboard-controller's avoiding view
    // with padding on both platforms, and no platform-specific header offset.
    const avoidingView = getByTestId("ai-panel-keyboard-avoiding-view");
    expect(avoidingView.props.behavior).toBe("padding");
    expect(avoidingView.props.keyboardVerticalOffset).toBe(0);
  });

  it("starts multiline input text at the top of the box", () => {
    const { getByTestId } = render(<AiPanel roomId="room-42" />);

    // Android centers multiline text vertically unless told otherwise; iOS
    // always starts at the top of the box.
    const input = getByTestId("ai-panel-input");
    expect(input.props.multiline).toBe(true);
    expect(StyleSheet.flatten(input.props.style).textAlignVertical).toBe("top");
  });
});
