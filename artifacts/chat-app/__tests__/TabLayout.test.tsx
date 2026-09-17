// The classic tab bar has three platform branches (iOS blur, Android panel,
// web panel on a fixed-height bar), and the point of this suite is to pin all
// three against each other, so each test sets Platform.OS explicitly instead
// of keying expectations with test-utils/platform.ts. The suite is still
// listed in jest.config.js's androidLayoutSuites: under the Android project
// the Android branch renders with react-native's real Android build.
import React from "react";
import { render } from "@testing-library/react-native";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import colors from "../constants/colors";
import TabLayout from "../app/(tabs)/_layout";

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

describe("classic tab bar surface", () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  it("draws a translucent tinted panel behind a hairline border on Android", () => {
    Platform.OS = "android";
    const view = render(<TabLayout />);

    // The bar itself stays clear so the screen shows through the panel, the
    // same way it shows through the iOS blur.
    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.backgroundColor).toBe("transparent");
    expect(bar.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(bar.borderTopColor).toBe(colors.dark.border);
    expect(bar.elevation).toBe(0);

    expect(surfaceStyle(view).backgroundColor).toBe(colors.dark.tabBarBackground);
    expect(parseColor(colors.dark.tabBarBackground).alpha).toBeLessThan(1);
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();
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

    const blur = view.getByTestId("tab-bar-blur");
    expect(blur.props.intensity).toBe(100);
    expect(StyleSheet.flatten(blur.props.style)).toEqual(
      StyleSheet.flatten(StyleSheet.absoluteFill),
    );
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
  });

  it("switches to the high-contrast panel with the palette", () => {
    Platform.OS = "android";
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

  it("replaces the Android panel with the opaque palette background", () => {
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

  it("returns to the see-through surface when the option is turned off again", () => {
    Platform.OS = "android";
    const view = render(<TabLayout />);
    expect(tabBarStyle(view).backgroundColor).toBe(colors.dark.background);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();

    mockReduceTransparency = false;
    view.rerender(<TabLayout />);

    expect(tabBarStyle(view).backgroundColor).toBe("transparent");
    expect(surfaceStyle(view).backgroundColor).toBe(colors.dark.tabBarBackground);
  });
});

describe("tab bar surface tokens", () => {
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

  it.each(palettes)(
    "%s keeps the tab tints readable on the opaque Reduce transparency bar",
    (name) => {
      const palette = colors[name];
      const surface = parseColor(palette.background);

      expect(surface.alpha).toBe(1);
      for (const tint of [palette.primary, palette.mutedForeground]) {
        expect(contrastRatio(parseColor(tint).rgb, surface.rgb)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
