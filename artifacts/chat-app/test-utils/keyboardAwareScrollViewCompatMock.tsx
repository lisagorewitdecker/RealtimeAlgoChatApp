/**
 * Shared stand-in for `components/KeyboardAwareScrollViewCompat` used by the
 * form-screen suites (SignIn, SignUp, Setup, NewRoom).
 *
 * The real component hands a form to react-native-keyboard-controller's
 * KeyboardAwareScrollView, which needs the native KeyboardProvider, so the
 * form suites replace it (`__tests__/KeyboardAwareScrollViewCompat.test.tsx`
 * renders the real one). A stand-in that only renders a plain ScrollView with
 * the screen's props cannot tell the compat component from no keyboard
 * handling at all: the screens pass their testID and
 * keyboardShouldPersistTaps="handled" themselves, so a screen rewritten to
 * `<ScrollView testID="sign-in-scroll" keyboardShouldPersistTaps="handled">`
 * renders the same tree, the compat import merely goes unused (the app
 * tsconfig does not enable noUnusedLocals), and phones lose keyboard-aware
 * scrolling on that form while every suite stays green.
 *
 * This stand-in therefore wraps the ScrollView in a host View tagged with
 * KEYBOARD_AWARE_SCROLL_VIEW_COMPAT_TEST_ID, which only the compat component
 * produces. Each form suite queries its inputs and submit control through
 * `withinKeyboardAwareScrollViewCompat(view)`, so a field rendered outside the
 * component — or a screen that dropped it — fails the suite under both Jest
 * projects. The screen's own props (testID, contentContainerStyle,
 * bottomOffset, …) stay on the inner ScrollView, so prop expectations keep
 * reading `getByTestId("<screen>-scroll")`.
 *
 * Install it in a suite with
 *   jest.mock("@/components/KeyboardAwareScrollViewCompat", () =>
 *     jest.requireActual("../test-utils/keyboardAwareScrollViewCompatMock"));
 */
import React from "react";
import { ScrollView, View } from "react-native";
import { within, type RenderResult } from "@testing-library/react-native";

import type { KeyboardAwareScrollViewCompat as RealKeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

/** testID of the host element the stand-in renders around the form. */
export const KEYBOARD_AWARE_SCROLL_VIEW_COMPAT_TEST_ID =
  "keyboard-aware-scroll-view-compat";

type Props = React.ComponentProps<typeof RealKeyboardAwareScrollViewCompat>;

export function KeyboardAwareScrollViewCompat({ children, ...props }: Props) {
  return (
    <View testID={KEYBOARD_AWARE_SCROLL_VIEW_COMPAT_TEST_ID}>
      <ScrollView {...props}>{children}</ScrollView>
    </View>
  );
}

/**
 * Queries scoped to the compat component's host element. A `getBy*` call on
 * the result throws for an input or button the screen renders outside
 * KeyboardAwareScrollViewCompat, and this helper itself throws when the screen
 * no longer renders the component at all.
 */
export function withinKeyboardAwareScrollViewCompat(
  view: Pick<RenderResult, "getByTestId">,
): ReturnType<typeof within> {
  let host: ReturnType<RenderResult["getByTestId"]>;
  try {
    host = view.getByTestId(KEYBOARD_AWARE_SCROLL_VIEW_COMPAT_TEST_ID);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      "The screen does not render KeyboardAwareScrollViewCompat (no element with testID " +
        `"${KEYBOARD_AWARE_SCROLL_VIEW_COMPAT_TEST_ID}"), so phones would not scroll the ` +
        "focused input above the keyboard. Wrap the form in KeyboardAwareScrollViewCompat " +
        `from components/KeyboardAwareScrollViewCompat.tsx.\n${detail}`,
    );
  }
  return within(host);
}
