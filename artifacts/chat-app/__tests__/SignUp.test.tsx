import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import SignUpScreen from "../app/(auth)/sign-up";

const mockCreate = jest.fn();
const mockPrepareEmailVerification = jest.fn();
const mockAttemptEmailVerification = jest.fn();
const mockSetActive = jest.fn();

jest.mock("@clerk/expo", () => ({
  useOAuth: () => ({ startOAuthFlow: jest.fn() }),
}));

jest.mock("@clerk/expo/legacy", () => ({
  useSignUp: () => ({
    signUp: {
      create: mockCreate,
      prepareEmailAddressVerification: mockPrepareEmailVerification,
      attemptEmailAddressVerification: mockAttemptEmailVerification,
    },
    setActive: mockSetActive,
    isLoaded: true,
  }),
}));

jest.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: jest.fn(),
}));

jest.mock("expo-router", () => {
  const RN = require("react-native");
  const mockReact = require("react");
  return {
    Link: ({ children }: { children: unknown }) =>
      mockReact.createElement(RN.Text, null, children),
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
    destructive: "#ef4444",
    radius: 10,
  }),
}));

describe("email account signup", () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue(undefined);
    mockPrepareEmailVerification.mockReset().mockResolvedValue(undefined);
    mockAttemptEmailVerification.mockReset().mockResolvedValue({
      status: "complete",
      createdSessionId: "session-verified",
    });
    mockSetActive.mockReset().mockResolvedValue(undefined);
  });

  it("requires the email code before activating a new session", async () => {
    const { findByPlaceholderText, getByLabelText, getByPlaceholderText } = render(
      <SignUpScreen />,
    );

    fireEvent.changeText(getByPlaceholderText("Email address"), "ada@example.com");
    fireEvent.changeText(getByPlaceholderText("Password"), "correct horse battery staple");
    await act(async () => {
      fireEvent.press(getByLabelText("Create account"));
    });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        emailAddress: "ada@example.com",
        password: "correct horse battery staple",
      });
      expect(mockPrepareEmailVerification).toHaveBeenCalledWith({
        strategy: "email_code",
      });
    });

    fireEvent.changeText(await findByPlaceholderText("Email verification code"), "123456");
    await act(async () => {
      fireEvent.press(getByLabelText("Verify email"));
    });

    await waitFor(() => {
      expect(mockAttemptEmailVerification).toHaveBeenCalledWith({
        code: "123456",
      });
      expect(mockSetActive).toHaveBeenCalledWith({ session: "session-verified" });
    });
  });

  it("uses the approved RealtimeAlgoChatApp Studio brand in the signup invitation", () => {
    const { getByText, queryByText } = render(<SignUpScreen />);

    expect(getByText("Join RealtimeAlgoChatApp Studio to chat, call, and build together.")).toBeTruthy();
    expect(queryByText("Join DevAlgoChat Studio to chat, call, and build together.")).toBeNull();
    expect(queryByText("Join DevStudio to chat, call, and build together.")).toBeNull();
  });
});