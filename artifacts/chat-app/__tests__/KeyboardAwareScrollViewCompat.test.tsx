// The form screens (SignIn, SignUp, Setup, NewRoom) mock this component in
// their own suites, and scripts/validate-keyboard-strategy.mjs only checks
// that they import it, so this is the one suite that renders the real
// component. It is listed in androidLayoutSuites (jest.config.js) and runs
// under both Jest projects:
// - on iOS and on Android a form must be handed to
//   react-native-keyboard-controller's KeyboardAwareScrollView, which scrolls
//   the focused input above the keyboard;
// - on web (Platform.OS set by hand; no Jest project exists for it) it must
//   stay on React Native's plain ScrollView;
// - both must default keyboardShouldPersistTaps to "handled" so a tap on a
//   submit button lands while an input is focused instead of only dismissing
//   the keyboard, and must pass the form's props and children through.
import React from "react";
import { render, within } from "@testing-library/react-native";
import { Platform, ScrollView, Text } from "react-native";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { testPlatform } from "../test-utils/platform";

// react-native-keyboard-controller's real component needs the native
// KeyboardProvider. The stand-in renders a tagged plain View — deliberately
// not a ScrollView — so the rendered tree tells the two branches apart.
const mockControllerTag = "keyboard-controller-keyboard-aware-scroll-view";

jest.mock("react-native-keyboard-controller", () => {
  const mockReact = require("react");
  const { View: MockView } = require("react-native");
  return {
    KeyboardAwareScrollView: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) =>
      mockReact.createElement(
        MockView,
        { ...props, testID: mockControllerTag },
        children,
      ),
  };
});

const { KeyboardAwareScrollView: MockKeyboardAwareScrollView } =
  jest.requireMock<{
    KeyboardAwareScrollView: React.ComponentType<Record<string, unknown>>;
  }>("react-native-keyboard-controller");

type Rendered = ReturnType<typeof render>;

// The platform react-native resolves to in this Jest project. It throws for a
// platform without a project, so the phone expectations below cannot silently
// run against anything but iOS or Android.
const nativePlatform = testPlatform();

// What the form screens pass: a test ID, styles, a controller-only offset and
// a handler, so that both scroll-view props and controller props are covered
// and the handler is checked by identity.
const onScroll = jest.fn();
const formProps = {
  testID: "sign-in-scroll",
  style: { backgroundColor: "#0d0d1a" },
  contentContainerStyle: { paddingTop: 48, paddingHorizontal: 24 },
  bottomOffset: 24,
  onScroll,
};

type CompatProps = React.ComponentProps<typeof KeyboardAwareScrollViewCompat>;

function renderForm(overrides: Partial<CompatProps> = {}) {
  return render(
    <KeyboardAwareScrollViewCompat {...formProps} {...overrides}>
      <Text>Email</Text>
      <Text>Sign in</Text>
    </KeyboardAwareScrollViewCompat>,
  );
}

describe("KeyboardAwareScrollViewCompat", () => {
  afterEach(() => {
    Platform.OS = nativePlatform;
  });

  it(`hands the form to react-native-keyboard-controller on ${nativePlatform}`, () => {
    const view = renderForm();

    expect(view.UNSAFE_getByType(MockKeyboardAwareScrollView)).toBeTruthy();
    expect(view.getByTestId(mockControllerTag)).toBeTruthy();
    // A plain ScrollView on a phone leaves the focused input under the keyboard.
    expect(view.UNSAFE_queryByType(ScrollView)).toBeNull();
  });

  it("keeps the plain React Native ScrollView on web", () => {
    Platform.OS = "web";
    const view = renderForm();

    expect(view.UNSAFE_getByType(ScrollView)).toBeTruthy();
    // The controller component has no web implementation to fall back on.
    expect(view.UNSAFE_queryByType(MockKeyboardAwareScrollView)).toBeNull();
    expect(view.queryByTestId(mockControllerTag)).toBeNull();
  });

  describe.each([
    {
      branch: `${nativePlatform}: react-native-keyboard-controller's KeyboardAwareScrollView`,
      os: nativePlatform,
      scrollContainer: (view: Rendered) =>
        view.UNSAFE_getByType(MockKeyboardAwareScrollView),
    },
    {
      branch: "web: React Native's ScrollView",
      os: "web" as const,
      scrollContainer: (view: Rendered) => view.UNSAFE_getByType(ScrollView),
    },
  ])("$branch", ({ os, scrollContainer }) => {
    beforeEach(() => {
      Platform.OS = os;
    });

    it('defaults keyboardShouldPersistTaps to "handled" so a tap on a button lands while an input is focused', () => {
      const view = renderForm();

      expect(scrollContainer(view).props.keyboardShouldPersistTaps).toBe(
        "handled",
      );
    });

    it("keeps an explicit keyboardShouldPersistTaps from the form", () => {
      const view = renderForm({ keyboardShouldPersistTaps: "always" });

      expect(scrollContainer(view).props.keyboardShouldPersistTaps).toBe(
        "always",
      );
    });

    it("forwards the form's props and children", () => {
      const view = renderForm();
      const container = scrollContainer(view);

      // toMatchObject compares the onScroll handler by identity.
      expect(container.props).toMatchObject(formProps);
      expect(within(container).getByText("Email")).toBeTruthy();
      expect(within(container).getByText("Sign in")).toBeTruthy();
    });
  });
});
