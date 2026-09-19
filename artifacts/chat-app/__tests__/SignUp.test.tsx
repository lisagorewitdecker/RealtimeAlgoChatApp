import React from "react";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import SignUpScreen from "../app/(auth)/sign-up";

const mockCreate = jest.fn();
const mockPrepareEmailVerification = jest.fn();
const mockAttemptEmailVerification = jest.fn();
const mockSetActive = jest.fn();

const mockStartAppleOAuthFlow = jest.fn();

jest.mock("@clerk/expo", () => ({
  useOAuth: ({ strategy }: { strategy: string }) => ({
    startOAuthFlow:
      strategy === "oauth_apple" ? mockStartAppleOAuthFlow : jest.fn(),
  }),
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

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
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

describe("Continue with Apple", () => {
  beforeEach(() => {
    mockStartAppleOAuthFlow.mockReset().mockResolvedValue({
      createdSessionId: "session-apple",
      setActive: mockSetActive,
    });
    mockSetActive.mockReset().mockResolvedValue(undefined);
  });

  it("activates the created Clerk session", async () => {
    const { getByLabelText } = render(<SignUpScreen />);

    fireEvent.press(getByLabelText("Continue with Apple"));

    await waitFor(() => {
      expect(mockStartAppleOAuthFlow).toHaveBeenCalledTimes(1);
      expect(mockSetActive).toHaveBeenCalledWith({ session: "session-apple" });
    });
  });

  it("uses the Apple-branded button alongside the other social providers", () => {
    const { getByLabelText, getByText } = render(<SignUpScreen />);

    const appleButton = getByLabelText("Continue with Apple");
    expect(StyleSheet.flatten(appleButton.props.style).backgroundColor).toBe("#000000");
    expect(StyleSheet.flatten(getByText("Continue with Apple").props.style).color).toBe("#FFFFFF");
    expect(getByLabelText("Continue with Google")).toBeTruthy();
    expect(getByLabelText("Continue with X")).toBeTruthy();
  });

  it("surfaces the Clerk error when the Apple flow fails", async () => {
    mockStartAppleOAuthFlow.mockRejectedValue({
      errors: [{ longMessage: "Apple sign-up was cancelled." }],
    });
    const { getByLabelText, findByText } = render(<SignUpScreen />);

    fireEvent.press(getByLabelText("Continue with Apple"));

    expect(await findByText("Apple sign-up was cancelled.")).toBeTruthy();
    expect(mockSetActive).not.toHaveBeenCalled();
  });

  it("reports an incomplete flow instead of activating nothing", async () => {
    mockStartAppleOAuthFlow.mockResolvedValue({
      createdSessionId: null,
      setActive: mockSetActive,
    });
    const { getByLabelText, findByText } = render(<SignUpScreen />);

    fireEvent.press(getByLabelText("Continue with Apple"));

    expect(await findByText("Unable to create your account. Please try again.")).toBeTruthy();
    expect(mockSetActive).not.toHaveBeenCalled();
  });
});

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

  it("uses the approved RealtimeAlgoChatApp brand in the signup invitation", () => {
    const { getByText, queryByText } = render(<SignUpScreen />);

    expect(getByText("Join RealtimeAlgoChatApp to chat, call, and build together.")).toBeTruthy();
    expect(queryByText("Join DevAlgoChat Studio to chat, call, and build together.")).toBeNull();
    expect(queryByText("Join DevStudio to chat, call, and build together.")).toBeNull();
  });

  it("keeps every field reachable above the keyboard with the shared keyboard-aware scroll wrapper", async () => {
    const { getByTestId, getByLabelText, findByPlaceholderText } = render(<SignUpScreen />);

    // Same wrapper and settings as sign-in: the on-screen keyboard (always
    // visible on Android) scrolls the focused field into view instead of
    // covering it, and taps on the buttons still land while it is open.
    const scroll = getByTestId("sign-up-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.props.keyboardDismissMode).toBe("interactive");
    expect(scroll.props.bottomOffset).toBe(68);

    const content = StyleSheet.flatten(scroll.props.contentContainerStyle);
    expect(content.flexGrow).toBe(1);
    expect(content.justifyContent).toBe("center");
    expect(content.paddingHorizontal).toBe(28);
    // Native safe-area insets (24 top / 12 bottom in this test) plus the
    // screen's own 28pt padding, mirroring sign-in; the web build would use
    // its fixed 67pt / 34pt instead. This suite runs under the iOS and Android
    // Jest projects, so both native platforms are held to the insets.
    expect(content.paddingTop).toBe(24 + 28);
    expect(content.paddingBottom).toBe(12 + 28);

    const fields = within(scroll);
    expect(fields.getByPlaceholderText("Email address")).toBeTruthy();
    expect(fields.getByPlaceholderText("Password")).toBeTruthy();

    // The verification step renders inside the same wrapper.
    fireEvent.changeText(fields.getByPlaceholderText("Email address"), "ada@example.com");
    fireEvent.changeText(fields.getByPlaceholderText("Password"), "correct horse battery staple");
    await act(async () => {
      fireEvent.press(getByLabelText("Create account"));
    });
    await findByPlaceholderText("Email verification code");
    expect(within(getByTestId("sign-up-scroll")).getByPlaceholderText("Email verification code")).toBeTruthy();
  });
});