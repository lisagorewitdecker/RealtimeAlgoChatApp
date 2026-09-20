// __tests__/TabLayout.test.tsx pins the props the iOS 26 layout hands
// expo-router's NativeTabs through a stand-in navigator. That proves what the
// layout asks for, not what UIKit is told: expo-router turns those props into
// two UITabBarAppearance descriptions per tab (standard, and the scroll-edge
// one it otherwise clears), and react-native-screens applies them verbatim.
// No iOS 26 device is reachable from this workspace, so this suite feeds the
// layout's real props through expo-router's real iOS appearance builders and
// pins the result — an Expo upgrade that renames an option or changes the
// scroll-edge gating fails here instead of on a phone.
import React from "react";
import { render } from "@testing-library/react-native";
import {
  createScrollEdgeAppearanceFromOptions,
  createStandardAppearanceFromOptions,
} from "expo-router/build/native-tabs/appearance.ios";
import type { NativeTabsLabelStyle, NativeTabsProps } from "expo-router/unstable-native-tabs";
import { Platform, StyleSheet, type ColorValue } from "react-native";
import type { TabsScreenAppearanceIOS } from "react-native-screens";
import colors from "../constants/colors";
import TabLayout from "../app/(tabs)/_layout";

// The per-tab options the builders accept (expo-router's NativeTabOptions,
// which the public entry point does not export).
type TabOptions = Parameters<typeof createStandardAppearanceFromOptions>[0];
type StateColors = { default?: ColorValue; selected?: ColorValue };
type StateLabelStyles = { default?: NativeTabsLabelStyle; selected?: NativeTabsLabelStyle };

let mockHighContrast = false;
let mockReduceTransparency = false;

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-symbols", () => ({
  SymbolView: () => null,
}));

jest.mock("expo-glass-effect", () => ({
  isLiquidGlassAvailable: () => true,
}));

jest.mock("expo-blur", () => ({
  BlurView: () => null,
}));

// The classic navigator is imported by the layout but never rendered here.
jest.mock("expo-router", () => {
  const Tabs = () => null;
  Tabs.Screen = () => null;
  return { Tabs };
});

// Records the props the layout passes to NativeTabs; the real navigator only
// renders inside expo-router's root.
jest.mock("expo-router/unstable-native-tabs", () => {
  const mockReact = require("react");
  const RN = require("react-native");
  const NativeTabs = ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [prop: string]: unknown;
  }) => mockReact.createElement(RN.View, { testID: "native-tabs", ...props }, children);
  const Trigger = ({ children }: { children: React.ReactNode }) =>
    mockReact.createElement(RN.View, null, children);
  Trigger.Icon = () => null;
  Trigger.Label = () => null;
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});

jest.mock("@/contexts/AccessibilityContext", () => ({
  useAccessibilityOptional: () => ({
    highContrast: mockHighContrast,
    reduceTransparency: mockReduceTransparency,
  }),
}));

function layoutProps(): NativeTabsProps {
  return render(<TabLayout />).getByTestId("native-tabs").props as NativeTabsProps;
}

// `iconColor` on <NativeTabs> is either one color for both item states or a
// `{ default, selected }` pair (a `ColorValue` can itself be an opaque
// object, so the pair is recognised by its keys, as expo-router does).
function splitIconColor(iconColor: NativeTabsProps["iconColor"]): StateColors {
  if (
    iconColor &&
    typeof iconColor === "object" &&
    ("default" in iconColor || "selected" in iconColor)
  ) {
    return iconColor as StateColors;
  }
  return { default: iconColor as ColorValue | undefined };
}

// Likewise `labelStyle` is one style for both states or a `{ default,
// selected }` pair of (possibly composed) styles.
function splitLabelStyle(labelStyle: NativeTabsProps["labelStyle"]): StateLabelStyles {
  if (labelStyle && ("default" in labelStyle || "selected" in labelStyle)) {
    const pair = labelStyle as {
      default?: Parameters<typeof StyleSheet.flatten>[0];
      selected?: Parameters<typeof StyleSheet.flatten>[0];
    };
    return {
      default: pair.default ? (StyleSheet.flatten(pair.default) as NativeTabsLabelStyle) : undefined,
      selected: pair.selected
        ? (StyleSheet.flatten(pair.selected) as NativeTabsLabelStyle)
        : undefined,
    };
  }
  return { default: labelStyle as NativeTabsLabelStyle | undefined };
}

// How expo-router's NativeTabsNavigator turns the props on <NativeTabs> into
// the options of every tab before the appearance builders see them
// (node_modules/expo-router/build/native-tabs/NativeBottomTabsNavigator.js):
// `labelStyle` and `iconColor` split into a default and a selected option,
// and the selected ones fall back to `tintColor`. The option names are typed
// against the builders' own parameter type, so a rename fails to compile.
function toTabOptions(props: NativeTabsProps): TabOptions {
  const labelStyle = splitLabelStyle(props.labelStyle);
  const iconColor = splitIconColor(props.iconColor);
  const selectedLabelStyle = labelStyle.selected
    ? { ...labelStyle.selected, color: labelStyle.selected.color ?? props.tintColor }
    : props.tintColor
      ? { color: props.tintColor }
      : undefined;

  return {
    disableTransparentOnScrollEdge: props.disableTransparentOnScrollEdge,
    labelStyle: labelStyle.default,
    selectedLabelStyle,
    iconColor: iconColor.default,
    selectedIconColor: iconColor.selected ?? props.tintColor,
    blurEffect: props.blurEffect,
    backgroundColor: props.backgroundColor,
    shadowColor: props.shadowColor,
    tintColor: props.tintColor,
  };
}

type Appearances = { standard: TabsScreenAppearanceIOS; scrollEdge: TabsScreenAppearanceIOS };

function appearancesFor(state: { highContrast: boolean; reduceTransparency: boolean }): {
  props: NativeTabsProps;
  appearances: Appearances;
} {
  mockHighContrast = state.highContrast;
  mockReduceTransparency = state.reduceTransparency;
  const props = layoutProps();
  const options = toTabOptions(props);
  return {
    props,
    appearances: {
      standard: createStandardAppearanceFromOptions(options),
      scrollEdge: createScrollEdgeAppearanceFromOptions(options),
    },
  };
}

const layouts = ["stacked", "inline", "compactInline"] as const;
const itemStates = ["normal", "selected", "focused"] as const;

// The bar background UIKit is given, in both appearances: with the scroll
// edge left to expo-router's default the bar would clear whenever content
// sits at the edge, which for short screens is most of the time.
function expectBarSurface(
  { standard, scrollEdge }: Appearances,
  surface: { backgroundColor: string; shadowColor: string },
) {
  for (const appearance of [standard, scrollEdge]) {
    expect(appearance.tabBarBackgroundColor).toBe(surface.backgroundColor);
    // "none" is what react-native-screens turns into `backgroundEffect = nil`;
    // together with a custom background it is how a bar leaves Liquid Glass.
    expect(appearance.tabBarBlurEffect).toBe("none");
    expect(appearance.tabBarShadowColor).toBe(surface.shadowColor);
  }
}

function expectItemTints(
  { standard, scrollEdge }: Appearances,
  tints: { inactive: string; active: string },
) {
  for (const appearance of [standard, scrollEdge]) {
    for (const layout of layouts) {
      const items = appearance[layout];
      expect(items?.normal).toMatchObject({
        tabBarItemIconColor: tints.inactive,
        tabBarItemTitleFontColor: tints.inactive,
      });
      // UIKit reads the focused state for the highlighted item as well.
      for (const state of ["selected", "focused"] as const) {
        expect(items?.[state]).toMatchObject({
          tabBarItemIconColor: tints.active,
          tabBarItemTitleFontColor: tints.active,
        });
      }
    }
  }
}

function expectNoItemTints({ standard, scrollEdge }: Appearances) {
  for (const appearance of [standard, scrollEdge]) {
    for (const layout of layouts) {
      for (const state of itemStates) {
        const item = appearance[layout]?.[state] ?? {};
        expect(item).not.toHaveProperty("tabBarItemIconColor");
        expect(item).not.toHaveProperty("tabBarItemTitleFontColor");
      }
    }
  }
}

describe("iOS 26 native tab bar through expo-router's appearance builders", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Platform.OS = "ios";
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  it("describes the default bar to UIKit without a background, so Liquid Glass stays", () => {
    const { props, appearances } = appearancesFor({
      highContrast: false,
      reduceTransparency: false,
    });

    expect(appearances.standard.tabBarBackgroundColor).toBeUndefined();
    expect(appearances.standard.tabBarBlurEffect).toBeUndefined();
    expect(appearances.standard.tabBarShadowColor).toBeUndefined();
    // expo-router's own scroll-edge default: no background, no material.
    expect(appearances.scrollEdge.tabBarBackgroundColor).toBeUndefined();
    expect(appearances.scrollEdge.tabBarBlurEffect).toBe("none");
    expectNoItemTints(appearances);
    // UITabBar's own tint stays the system's too.
    expect(props.tintColor).toBeUndefined();
  });

  it("describes an opaque palette bar with system item tints for Reduce transparency", () => {
    const { props, appearances } = appearancesFor({
      highContrast: false,
      reduceTransparency: true,
    });

    expectBarSurface(appearances, {
      backgroundColor: colors.dark.background,
      shadowColor: colors.dark.border,
    });
    expectNoItemTints(appearances);
    expect(props.tintColor).toBeUndefined();
  });

  it("describes the denser high-contrast panel and palette item tints for high contrast", () => {
    const { props, appearances } = appearancesFor({
      highContrast: true,
      reduceTransparency: false,
    });

    expectBarSurface(appearances, {
      backgroundColor: colors.highContrast.tabBarBackground,
      shadowColor: colors.highContrast.border,
    });
    expectItemTints(appearances, {
      inactive: colors.highContrast.mutedForeground,
      active: colors.highContrast.primary,
    });
    // The host-level tint (UITabBar.tintColor) matches the selected items, so
    // anything UIKit tints from the bar rather than the item agrees with them.
    expect(props.tintColor).toBe(colors.highContrast.primary);
  });

  it("describes the opaque high-contrast bar with palette item tints when both are on", () => {
    const { props, appearances } = appearancesFor({
      highContrast: true,
      reduceTransparency: true,
    });

    expectBarSurface(appearances, {
      backgroundColor: colors.highContrast.background,
      shadowColor: colors.highContrast.border,
    });
    expectItemTints(appearances, {
      inactive: colors.highContrast.mutedForeground,
      active: colors.highContrast.primary,
    });
    expect(props.tintColor).toBe(colors.highContrast.primary);
  });

  it("would lose the requested surface at the scroll edge without disableTransparentOnScrollEdge", () => {
    // Documents why the layout's four surface props travel together: the
    // scroll-edge builder drops the background and forces the material off
    // unless the flag is set, so a background on its own is not a solid bar.
    mockReduceTransparency = true;
    const options = toTabOptions(layoutProps());
    const withoutFlag = createScrollEdgeAppearanceFromOptions({
      ...options,
      disableTransparentOnScrollEdge: undefined,
    });

    expect(options.disableTransparentOnScrollEdge).toBe(true);
    expect(withoutFlag.tabBarBackgroundColor).toBeUndefined();
    expect(withoutFlag.tabBarShadowColor).toBe("transparent");
  });
});
