import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import SignInScreen from "../app/(auth)/sign-in";

const mockCreate = jest.fn();
const mockPrepareFirstFactor = jest.fn();
const mockAttemptFirstFactor = jest.fn();
const mockResetPassword = jest.fn();
const mockSetActive = jest.fn();

jest.mock("@clerk/expo", () => ({
  useOAuth: () => ({ startOAuthFlow: jest.fn() }),
}));

jest.mock("@clerk/expo/legacy", () => ({
  useSignIn: () => ({
    signIn: {
      create: mockCreate,
      prepareFirstFactor: mockPrepareFirstFactor,
      attemptFirstFactor: mockAttemptFirstFactor,
      resetPassword: mockResetPassword,
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

describe("client trust verification", () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({
      status: "needs_client_trust",
      supportedFirstFactors: [
        {
          strategy: "email_code",
          emailAddressId: "email-ada",
        },
      ],
    });
    mockPrepareFirstFactor.mockReset().mockResolvedValue(undefined);
    mockAttemptFirstFactor.mockReset().mockResolvedValue({
      status: "complete",
      createdSessionId: "session-trusted",
    });
    mockResetPassword.mockReset();
    mockSetActive.mockReset().mockResolvedValue(undefined);
  });

  it("sends and verifies the Clerk email code", async () => {
    const { findByPlaceholderText, getByLabelText, getByPlaceholderText } =
      render(<SignInScreen />);

    fireEvent.changeText(
      getByPlaceholderText("Email address"),
      "ada@example.com",
    );
    fireEvent.changeText(getByPlaceholderText("Password"), "secure password");
    fireEvent.press(getByLabelText("Sign in"));

    await waitFor(() => {
      expect(mockPrepareFirstFactor).toHaveBeenCalledWith({
        strategy: "email_code",
        emailAddressId: "email-ada",
      });
    });

    fireEvent.changeText(await findByPlaceholderText("6-digit code"), "424242");
    fireEvent.press(getByLabelText("Verify"));

    await waitFor(() => {
      expect(mockAttemptFirstFactor).toHaveBeenCalledWith({
        strategy: "email_code",
        code: "424242",
      });
      expect(mockSetActive).toHaveBeenCalledWith({
        session: "session-trusted",
      });
    });
  });
});

describe("password reset", () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue(undefined);
    mockPrepareFirstFactor.mockReset();
    mockAttemptFirstFactor.mockReset().mockResolvedValue({
      status: "needs_new_password",
    });
    mockResetPassword.mockReset().mockResolvedValue({
      status: "complete",
      createdSessionId: "session-reset",
    });
    mockSetActive.mockReset().mockResolvedValue(undefined);
  });

  it("requests a code, verifies it, and activates the new password", async () => {
    const { findByPlaceholderText, getByLabelText, getByPlaceholderText } = render(
      <SignInScreen />,
    );

    fireEvent.changeText(getByPlaceholderText("Email address"), "ada@example.com");
    fireEvent.press(getByLabelText("Forgot password"));
    fireEvent.press(getByLabelText("Send reset code"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        strategy: "reset_password_email_code",
        identifier: "ada@example.com",
      });
    });

    fireEvent.changeText(await findByPlaceholderText("Reset code"), "123456");
    fireEvent.press(getByLabelText("Verify reset code"));

    await waitFor(() => {
      expect(mockAttemptFirstFactor).toHaveBeenCalledWith({
        strategy: "reset_password_email_code",
        code: "123456",
      });
    });

    fireEvent.changeText(await findByPlaceholderText("New password"), "new secure password");
    fireEvent.press(getByLabelText("Update password"));

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith({
        password: "new secure password",
      });
      expect(mockSetActive).toHaveBeenCalledWith({ session: "session-reset" });
    });
  });

  it("opens the reset form even when no email has been entered", () => {
    const { getByLabelText, getByText } = render(<SignInScreen />);

    fireEvent.press(getByLabelText("Forgot password"));

    expect(getByText("Reset your password")).toBeTruthy();
    expect(getByLabelText("Send reset code")).toBeTruthy();
  });
});

describe("default sign in", () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue(undefined);
    mockPrepareFirstFactor.mockReset();
    mockAttemptFirstFactor.mockReset().mockResolvedValue({
      status: "needs_new_password",
    });
    mockResetPassword.mockReset().mockResolvedValue({
      status: "complete",
      createdSessionId: "session-reset",
    });
    mockSetActive.mockReset().mockResolvedValue(undefined);
  });

  it("uses an accessible workspace heading and lower-case greeting", () => {
    const { getByTestId, getByText } = render(<SignInScreen />);
    const title = getByText("Sign in to your RealtimeAlgoChatApp Studio Workspace");
    const greeting = getByText("welcome back");

    expect(title.props.accessibilityRole).toBe("header");
    expect(title.props.role).toBe("heading");
    expect(title.props["aria-level"]).toBe(1);
    expect(greeting.props.accessibilityRole).toBe("header");
    expect(greeting.props.role).toBe("heading");
    expect(greeting.props["aria-level"]).toBe(2);
    expect(getByText("Sign in to your RealtimeAlgoChatApp Studio workspace.")).toBeTruthy();
    expect(title.props.style.fontSize).toBeCloseTo(39.2);

    const scroll = getByTestId("sign-in-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).flexGrow).toBe(1);
    expect(getByText("Continue with Google").props.style.fontSize).toBeCloseTo(21);
  });

  it("keeps the greeting out of password reset variants", () => {
    const { getByLabelText, getByText, queryByText } = render(<SignInScreen />);

    fireEvent.press(getByLabelText("Forgot password"));

    expect(getByText("Reset your password")).toBeTruthy();
    expect(queryByText("welcome back")).toBeNull();
  });

  it("uses the approved brand in the password reset completion state", async () => {
    const { findByPlaceholderText, getByLabelText, getByText } = render(
      <SignInScreen />,
    );

    fireEvent.changeText(
      await findByPlaceholderText("Email address"),
      "ada@example.com",
    );
    fireEvent.press(getByLabelText("Forgot password"));
    fireEvent.press(getByLabelText("Send reset code"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });

    fireEvent.changeText(await findByPlaceholderText("Reset code"), "123456");
    fireEvent.press(getByLabelText("Verify reset code"));

    await waitFor(() => {
      expect(getByText("Choose a new password for your RealtimeAlgoChatApp Studio account.")).toBeTruthy();
    });
  });
});