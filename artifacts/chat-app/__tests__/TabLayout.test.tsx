// The classic tab bar has three platform branches (iOS blur, opaque Android
// web panel on a fixed-height bar). Two kinds of test pin them:
//
// - "under the current Jest project's platform" leaves react-native's
//   Platform module alone and keys its expectations with
//   test-utils/platform.ts. The suite is listed in jest.config.js's
//   androidLayoutSuites, so the Android project proves that react-native's
//   real Android build takes the Android branch (an opaque bar, no blur, no
//   panel, no fixed height) and the iOS project proves the iOS one.
// - "classic tab bar surface" sets Platform.OS explicitly so all three
//   branches, including web (which has no Jest project), are compared against
//   each other in the same run.
import React from "react";
import { render } from "@testing-library/react-native";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import colors from "../constants/colors";
import TabLayout from "../app/(tabs)/_layout";
import { onTestPlatform } from "../test-utils/platform";

let mockHighContrast = false;
let mockReduceTransparency = false;

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-symbols", () => ({
  SymbolView: () => null,
}));

jest.mock("expo-glass-effect", () => ({
  isLiquidGlassAvailable: () => false,
}));

jest.mock("expo-blur", () => {
  const mockReact = require("react");
  const RN = require("react-native");
  return {
    BlurView: (props: Record<string, unknown>) =>
      mockReact.createElement(RN.View, { ...props, testID: "tab-bar-blur" }),
  };
});

// The real navigator pulls in expo-router's ESM-only dependencies, which Jest
// cannot parse. This stand-in applies `tabBarStyle` and renders
// `tabBarBackground` the way the classic bottom tab bar does: the background
// element fills the bar behind the tab items.
jest.mock("expo-router", () => {
  const mockReact = require("react");
  const RN = require("react-native");
  const Tabs = ({
    screenOptions,
    children,
  }: {
    screenOptions: {
      tabBarStyle: StyleProp<ViewStyle>;
      tabBarBackground?: () => React.ReactNode;
    };
    children: React.ReactNode;
  }) =>
    mockReact.createElement(
      RN.View,
      { testID: "tab-bar", style: screenOptions.tabBarStyle },
      mockReact.createElement(
        RN.View,
        { testID: "tab-bar-background", style: RN.StyleSheet.absoluteFill },
        screenOptions.tabBarBackground?.(),
      ),
      children,
    );
  Tabs.Screen = () => null;
  return { Tabs };
});

jest.mock("expo-router/unstable-native-tabs", () => {
  const NativeTabs = () => null;
  const Trigger = () => null;
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

type Rgb = [number, number, number];
type Layer = { rgb: Rgb; alpha: number };

function parseColor(color: string): Layer {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const value = parseInt(hex[1], 16);
    return {
      rgb: [(value >> 16) & 255, (value >> 8) & 255, value & 255],
      alpha: 1,
    };
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d*\.?\d+)\s*\)$/.exec(color);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: Number(rgba[4]),
    };
  }
  throw new Error(`Unsupported color: ${color}`);
}

// Source-over compositing of a translucent layer on an opaque backdrop.
function composite(layer: Layer, backdrop: Rgb): Rgb {
  return layer.rgb.map(
    (channel, index) => channel * layer.alpha + backdrop[index] * (1 - layer.alpha),
  ) as Rgb;
}

// WCAG 2.x relative luminance and contrast ratio.
function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

type Rendered = ReturnType<typeof render>;

function tabBarStyle(view: Rendered) {
  return StyleSheet.flatten(view.getByTestId("tab-bar").props.style as StyleProp<ViewStyle>);
}

function surfaceStyle(view: Rendered) {
  return StyleSheet.flatten(
    view.getByTestId("tab-bar-surface").props.style as StyleProp<ViewStyle>,
  );
}

// Android paints the bar itself with the opaque palette background and draws
// neither the blur nor the tinted panel behind the tab items. A bar whose
// background was dropped or made translucent would show the chat list through
// it; a stray panel or blur would draw a second surface over the solid one.
function expectAndroidOpaqueBar(view: Rendered) {
  const bar = tabBarStyle(view);
  expect(bar.backgroundColor).toBe(colors.dark.background);
  expect(parseColor(colors.dark.background).alpha).toBe(1);
  expect(view.queryByTestId("tab-bar-blur")).toBeNull();
  expect(view.queryByTestId("tab-bar-surface")).toBeNull();
}

// iOS keeps the bar clear and draws the native blur filling it, no panel.
function expectIOSBlur(view: Rendered) {
  expect(tabBarStyle(view).backgroundColor).toBe("transparent");
  const blur = view.getByTestId("tab-bar-blur");
  expect(blur.props.intensity).toBe(100);
  expect(StyleSheet.flatten(blur.props.style)).toEqual(
    StyleSheet.flatten(StyleSheet.absoluteFill),
  );
  expect(view.queryByTestId("tab-bar-surface")).toBeNull();
}

describe("under the current Jest project's platform", () => {
  it("draws the surface of the platform react-native resolved to", () => {
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(onTestPlatform({ ios: 1, android: StyleSheet.hairlineWidth }));
    expect(bar.borderTopColor).toBe(colors.dark.border);
    expect(bar.elevation).toBe(0);

    onTestPlatform({ ios: expectIOSBlur, android: expectAndroidOpaqueBar })(view);
  });

  it("leaves the bar's height and bottom inset to the navigator", () => {
    // The classic bottom tab bar sizes itself as the item row plus the
    // bottom safe-area inset, pads the items above that inset, and publishes
    // the measured total through BottomTabBarHeightContext for the screens to
    // reserve (see ProfileModeration.test.tsx). `tabBarStyle` is applied
    // last, so a numeric `height` or a `paddingBottom` there would replace
    // both and mis-size the bar on every phone whose inset differs from the
    // guess. The fixed height belongs to web only, where no inset is
    // measured.
    const bar = tabBarStyle(render(<TabLayout />));

    expect(bar.height).toBeUndefined();
    expect(bar.paddingBottom).toBeUndefined();
  });
});

describe("classic tab bar surface", () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  it("paints an opaque bar behind a hairline border on Android", () => {
    Platform.OS = "android";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(bar.borderTopColor).toBe(colors.dark.border);
    expect(bar.elevation).toBe(0);
    expect(bar.height).toBeUndefined();

    expectAndroidOpaqueBar(view);
  });

  it("gives web the same panel on its fixed-height bar", () => {
    Platform.OS = "web";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe("transparent");
    expect(bar.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(bar.height).toBe(84);
    expect(surfaceStyle(view).backgroundColor).toBe(colors.dark.tabBarBackground);
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();
  });

  it("keeps the native blur on iOS", () => {
    Platform.OS = "ios";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe("transparent");
    expect(bar.borderTopWidth).toBe(1);
    expect(bar.height).toBeUndefined();

    expectIOSBlur(view);
  });

  it("switches the Android bar to the high-contrast palette", () => {
    Platform.OS = "android";
    mockHighContrast = true;
    const view = render(<TabLayout />);

    expect(tabBarStyle(view).backgroundColor).toBe(colors.highContrast.background);
    expect(tabBarStyle(view).borderTopColor).toBe(colors.highContrast.border);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
  });

  it("switches the web panel to the high-contrast palette", () => {
    Platform.OS = "web";
    mockHighContrast = true;
    const view = render(<TabLayout />);

    expect(surfaceStyle(view).backgroundColor).toBe(colors.highContrast.tabBarBackground);
    expect(tabBarStyle(view).borderTopColor).toBe(colors.highContrast.border);
  });
});

// The Reduce transparency accessibility option (the in-app toggle, which
// follows iOS's system setting until the user changes it) replaces the
// see-through surface with the opaque palette background. The layout must
// otherwise be identical: the bar stays absolutely positioned with the same
// border so the height screens reserve through useTabBarContentInset does not
// move.
describe("classic tab bar with Reduce transparency", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    mockReduceTransparency = true;
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  it("keeps Android opaque when Reduce transparency is enabled", () => {
    Platform.OS = "android";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe(colors.dark.background);
    expect(parseColor(colors.dark.background).alpha).toBe(1);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();

    // Same bar otherwise: still overlaid, still bordered.
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(bar.borderTopColor).toBe(colors.dark.border);
    expect(bar.elevation).toBe(0);
  });

  it("replaces the iOS blur with the opaque palette background", () => {
    Platform.OS = "ios";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe(colors.dark.background);
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(1);
    expect(bar.borderTopColor).toBe(colors.dark.border);
  });

  it("replaces the web panel while keeping the fixed-height bar", () => {
    Platform.OS = "web";
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe(colors.dark.background);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(bar.height).toBe(84);
  });

  it("uses the high-contrast background when both options are on", () => {
    Platform.OS = "android";
    mockHighContrast = true;
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe(colors.highContrast.background);
    expect(parseColor(colors.highContrast.background).alpha).toBe(1);
    expect(bar.borderTopColor).toBe(colors.highContrast.border);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
  });

  it("returns to the translucent web surface when the option is turned off again", () => {
    Platform.OS = "web";
    const view = render(<TabLayout />);
    expect(tabBarStyle(view).backgroundColor).toBe(colors.dark.background);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();

    mockReduceTransparency = false;
    view.rerender(<TabLayout />);

    expect(tabBarStyle(view).backgroundColor).toBe("transparent");
    expect(surfaceStyle(view).backgroundColor).toBe(colors.dark.tabBarBackground);
  });
});

describe("Android tab bar surface tokens", () => {
  const palettes = ["light", "dark", "highContrast"] as const;

  it.each(palettes)("%s keeps the tab tints readable on the opaque bar", (name) => {
    const palette = colors[name];
    const bar = parseColor(palette.background);
    expect(bar.alpha).toBe(1);

    // WCAG AA for normal text; the tab labels are small text.
    for (const tint of [palette.primary, palette.mutedForeground]) {
      expect(contrastRatio(parseColor(tint).rgb, bar.rgb)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("web tab bar surface tokens", () => {
  const palettes = ["light", "dark", "highContrast"] as const;
  const white: Rgb = [255, 255, 255];

  it.each(palettes)("%s tints the palette background without going opaque", (name) => {
    const palette = colors[name];
    const surface = parseColor(palette.tabBarBackground);

    expect(surface.rgb).toEqual(parseColor(palette.background).rgb);
    expect(surface.alpha).toBeGreaterThan(0);
    expect(surface.alpha).toBeLessThan(1);
  });

  it.each(palettes)(
    "%s keeps the tab tints readable over whatever scrolls under the bar",
    (name) => {
      const palette = colors[name];
      const surface = parseColor(palette.tabBarBackground);
      // Pure white is the brightest thing that can scroll under the bar and
      // therefore the worst case for the light tab tints; the palette's own
      // surfaces and accents cover the everyday cases.
      const backdrops = [
        white,
        parseColor(palette.background).rgb,
        parseColor(palette.card).rgb,
        parseColor(palette.text).rgb,
        parseColor(palette.primary).rgb,
      ];
      const tints = {
        active: parseColor(palette.primary).rgb,
        inactive: parseColor(palette.mutedForeground).rgb,
      };

      for (const backdrop of backdrops) {
        const composited = composite(surface, backdrop);
        for (const tint of Object.values(tints)) {
          // WCAG AA for normal text; the tab labels are small text.
          expect(contrastRatio(tint, composited)).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

});
