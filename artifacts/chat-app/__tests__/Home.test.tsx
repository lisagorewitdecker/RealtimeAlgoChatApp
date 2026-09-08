import React from "react";
import { render } from "@testing-library/react-native";
import ChatsScreen from "../app/(tabs)/index";

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

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
  it("shows the accessible greeting", () => {
    const { getByText } = render(<ChatsScreen />);
    const greeting = getByText("welcome back");

    expect(greeting.props.accessibilityRole).toBe("header");
    expect(greeting.props.role).toBe("heading");
    expect(greeting.props["aria-level"]).toBe(2);
    expect(getByText("Hi, Ada")).toBeTruthy();
  });

  it("applies the selected scale to the home headings", () => {
    const { getByText } = render(<ChatsScreen />);

    expect(getByText("RealtimeAlgoChatApp Studio").props.style.fontSize).toBeCloseTo(39.2);
    expect(getByText("welcome back").props.style.fontSize).toBeCloseTo(28);
  });
});