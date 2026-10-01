// The classic tab bar has three platform branches (iOS blur, opaque Android
// bar, web panel on a fixed-height bar) and two accessibility variants: high
// contrast swaps the iOS blur for the palette's denser panel (web's panel
// simply follows the palette; Android stays opaque), and Reduce transparency
// makes every platform opaque. Two kinds of test pin them:
//
// - "under the current Jest project's platform" leaves react-native's
//   Platform module alone and keys its expectations with
//   test-utils/platform.ts. The suite is listed in jest.config.js's
//   androidLayoutSuites, so the Android project proves that react-native's
//   real Android build takes the Android branch (an opaque bar, no blur, no
//   panel, no fixed height) and the iOS project proves the iOS ones (blur by
//   default, panel with high contrast).
// - "classic tab bar surface" sets Platform.OS explicitly so all three
//   branches, including web (which has no Jest project), are compared against
//   each other in the same run.
//
// On iOS 26 the layout renders expo-router's NativeTabs (Liquid Glass) instead
// of the classic bar. "iOS 26 native tab bar" flips the mocked
// isLiquidGlassAvailable to true and pins the appearance props the layout
// passes: none by default, the opaque set with Reduce transparency on, the
// denser high-contrast panel plus the palette's item tints with high contrast
// on, and the opaque high-contrast bar with those tints when both are on.
import React from "react";
import { render } from "@testing-library/react-native";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import colors from "../constants/colors";
import TabLayout from "../app/(tabs)/_layout";
import { onTestPlatform } from "../test-utils/platform";

let mockHighContrast = false;
let mockReduceTransparency = false;
let mockLiquidGlassAvailable = false;

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("expo-symbols", () => ({
  SymbolView: () => null,
}));

jest.mock("expo-glass-effect", () => ({
  isLiquidGlassAvailable: () => mockLiquidGlassAvailable,
}));

jest.mock("expo-blur", () => {
  const mockReact = require("react");
  const RN = require("react-native");
  return {
    BlurView: (props: Record<string, unknown>) =>
      mockReact.createElement(RN.View, { ...props, testID: "tab-bar-blur" }),
  };
});

// The real navigator only renders inside expo-router's root, and under Jest it
// also needs a stand-in for one ESM-only dependency. This stand-in applies
// `tabBarStyle` and renders `tabBarBackground` the way the classic bottom tab
// bar does: the background element fills the bar behind the tab items.
// __tests__/VendoredBottomTabBar.test.tsx renders expo-router's real vendored
// bar with the same options and fails when an Expo upgrade stops it behaving
// this way, so keep the two in step.
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

// The native tab bar is drawn by UIKit, so the only thing the layout controls
// is the props it hands NativeTabs. This stand-in records them on a host view
// (and each trigger's route name) for the "iOS 26 native tab bar" suite.
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
  const Trigger = ({ name, children }: { name: string; children: React.ReactNode }) =>
    mockReact.createElement(RN.View, { testID: "native-tab-trigger", name }, children);
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

type Palette = (typeof colors)["light" | "dark" | "highContrast"];

// Android paints the bar itself with the opaque palette background and draws
// neither the blur nor the tinted panel behind the tab items. A bar whose
// background was dropped or made translucent would show the chat list through
// it; a stray panel or blur would draw a second surface over the solid one.
function expectAndroidOpaqueBar(view: Rendered, palette: Palette = colors.dark) {
  const bar = tabBarStyle(view);
  expect(bar.backgroundColor).toBe(palette.background);
  expect(parseColor(palette.background).alpha).toBe(1);
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

// The palette's translucent panel fills the clear bar behind the tab items,
// no blur: web's everyday surface, and what iOS draws in place of the blur
// while high contrast is on.
function expectPanel(view: Rendered, palette: Palette) {
  expect(tabBarStyle(view).backgroundColor).toBe("transparent");
  const surface = surfaceStyle(view);
  expect(surface.backgroundColor).toBe(palette.tabBarBackground);
  expect(surface).toMatchObject(StyleSheet.flatten(StyleSheet.absoluteFill));
  expect(view.queryByTestId("tab-bar-blur")).toBeNull();
}

describe("under the current Jest project's platform", () => {
  afterEach(() => {
    mockHighContrast = false;
  });

  it("draws the surface of the platform react-native resolved to", () => {
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(onTestPlatform({ ios: 1, android: StyleSheet.hairlineWidth }));
    expect(bar.borderTopColor).toBe(colors.dark.border);
    expect(bar.elevation).toBe(0);

    onTestPlatform({ ios: expectIOSBlur, android: expectAndroidOpaqueBar })(view);
  });

  it("swaps the iOS blur for the high-contrast panel and keeps Android opaque", () => {
    // The high-contrast palette exists to take visual noise away from
    // low-vision users, and the blur is the busiest of the surfaces, so iOS
    // draws the palette's denser panel instead (web draws the same one).
    // Android's opaque bar simply takes the palette.
    mockHighContrast = true;
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(onTestPlatform({ ios: 1, android: StyleSheet.hairlineWidth }));
    expect(bar.borderTopColor).toBe(colors.highContrast.border);
    expect(bar.height).toBeUndefined();

    onTestPlatform<(view: Rendered) => void>({
      ios: (rendered) => expectPanel(rendered, colors.highContrast),
      android: (rendered) => expectAndroidOpaqueBar(rendered, colors.highContrast),
    })(view);
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

    expectPanel(view, colors.highContrast);
    expect(tabBarStyle(view).borderTopColor).toBe(colors.highContrast.border);
  });

  it("replaces the iOS blur with the same high-contrast panel web draws", () => {
    Platform.OS = "ios";
    mockHighContrast = true;
    const view = render(<TabLayout />);

    expectPanel(view, colors.highContrast);

    // Same bar otherwise: still overlaid and bordered like the blurred one,
    // still sized by the navigator, so the reserved height does not move.
    const bar = tabBarStyle(view);
    expect(bar.position).toBe("absolute");
    expect(bar.borderTopWidth).toBe(1);
    expect(bar.borderTopColor).toBe(colors.highContrast.border);
    expect(bar.height).toBeUndefined();
  });

  it("brings the iOS blur back when high contrast is turned off again", () => {
    Platform.OS = "ios";
    mockHighContrast = true;
    const view = render(<TabLayout />);
    expectPanel(view, colors.highContrast);

    mockHighContrast = false;
    view.rerender(<TabLayout />);

    expectIOSBlur(view);
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

  it("makes iOS opaque instead of drawing the high-contrast panel when both options are on", () => {
    // High contrast alone leaves iOS faintly see-through (the denser panel);
    // Reduce transparency is the stronger request and wins.
    Platform.OS = "ios";
    mockHighContrast = true;
    const view = render(<TabLayout />);

    const bar = tabBarStyle(view);
    expect(bar.backgroundColor).toBe(colors.highContrast.background);
    expect(parseColor(colors.highContrast.background).alpha).toBe(1);
    expect(bar.borderTopColor).toBe(colors.highContrast.border);
    expect(bar.borderTopWidth).toBe(1);
    expect(view.queryByTestId("tab-bar-surface")).toBeNull();
    expect(view.queryByTestId("tab-bar-blur")).toBeNull();
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

// On iOS 26 (expo-glass-effect reports Liquid Glass available) the layout
// renders expo-router's NativeTabs and UIKit draws the bar. iOS's own Reduce
// Transparency setting solidifies that glass by itself, but the in-app toggles
// are preferences the system never sees, so the layout has to pass the
// appearance explicitly. A surface is requested with four props together:
// `backgroundColor` fills the bar, `blurEffect="none"` removes the material
// behind it, `disableTransparentOnScrollEdge` keeps that background at the
// scroll edge (where expo-router otherwise clears the bar), and `shadowColor`
// draws the top border. Reduce transparency asks for the opaque palette
// background; high contrast alone asks for the palette's denser (still
// see-through) panel and colors the tab items with the high-contrast palette
// through `tintColor`, `iconColor` and `labelStyle`. With both toggles off none
// of these may be passed, or the tabs lose their default Liquid Glass look and
// system tints.
describe("iOS 26 native tab bar", () => {
  const originalPlatform = Platform.OS;
  const surfaceProps = [
    "backgroundColor",
    "blurEffect",
    "disableTransparentOnScrollEdge",
    "shadowColor",
  ] as const;
  const tintProps = ["tintColor", "iconColor", "labelStyle"] as const;

  beforeEach(() => {
    Platform.OS = "ios";
    mockLiquidGlassAvailable = true;
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockLiquidGlassAvailable = false;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  function nativeTabsProps(view: Rendered) {
    return view.getByTestId("native-tabs").props as Record<string, unknown>;
  }

  // UIKit's defaults: Liquid Glass behind system blue / gray items.
  function expectSystemTints(view: Rendered) {
    const props = nativeTabsProps(view);
    for (const prop of tintProps) {
      expect(props[prop]).toBeUndefined();
    }
  }

  function expectLiquidGlass(view: Rendered) {
    const props = nativeTabsProps(view);
    for (const prop of surfaceProps) {
      expect(props[prop]).toBeUndefined();
    }
    expectSystemTints(view);
  }

  // The four surface props always travel together: expo-router's scroll-edge
  // appearance drops `backgroundColor` and forces `blurEffect` to none unless
  // `disableTransparentOnScrollEdge` is set, so a partial set would leave the
  // bar clear whenever content sits at the scroll edge.
  function expectSurface(view: Rendered, surface: string, palette: Palette) {
    const props = nativeTabsProps(view);
    expect(props.backgroundColor).toBe(surface);
    expect(props.blurEffect).toBe("none");
    expect(props.disableTransparentOnScrollEdge).toBe(true);
    expect(props.shadowColor).toBe(palette.border);
  }

  function expectOpaqueNativeBar(view: Rendered, palette: Palette) {
    expectSurface(view, palette.background, palette);
    expect(parseColor(palette.background).alpha).toBe(1);
  }

  // The same denser panel the classic iOS bar swaps in for its blur: the
  // palette background at partial opacity, so it is not the opaque bar.
  function expectHighContrastPanel(view: Rendered) {
    expectSurface(view, colors.highContrast.tabBarBackground, colors.highContrast);
    const panel = parseColor(colors.highContrast.tabBarBackground);
    expect(panel.alpha).toBeGreaterThan(0);
    expect(panel.alpha).toBeLessThan(1);
  }

  // The classic bar's tints (`tabBarActiveTintColor` / `tabBarInactiveTintColor`)
  // mapped onto NativeTabs: `tintColor` is UITabBar's selected tint, while
  // `iconColor` and `labelStyle` set both item states explicitly so the
  // unselected items do not stay system gray.
  function expectHighContrastTints(view: Rendered) {
    const props = nativeTabsProps(view);
    const palette = colors.highContrast;
    expect(props.tintColor).toBe(palette.primary);
    expect(props.iconColor).toEqual({
      default: palette.mutedForeground,
      selected: palette.primary,
    });
    expect(props.labelStyle).toEqual({
      default: { color: palette.mutedForeground },
      selected: { color: palette.primary },
    });
  }

  it("renders the native tabs for both routes instead of the classic bar", () => {
    const view = render(<TabLayout />);

    expect(view.queryByTestId("tab-bar")).toBeNull();
    expect(
      view.getAllByTestId("native-tab-trigger").map((trigger) => trigger.props.name),
    ).toEqual(["index", "profile"]);
  });

  it("leaves the default Liquid Glass look and system tints alone while both options are off", () => {
    expectLiquidGlass(render(<TabLayout />));
  });

  it("asks for an opaque bar while Reduce transparency is on", () => {
    mockReduceTransparency = true;
    const view = render(<TabLayout />);

    expectOpaqueNativeBar(view, colors.dark);
    // Reduce transparency changes the surface only; the items keep UIKit's
    // tints, as they do on the default glass.
    expectSystemTints(view);
  });

  it("swaps the glass for the high-contrast panel and palette tints with high contrast alone", () => {
    // High contrast alone never makes a surface opaque — that is Reduce
    // transparency's job, and the two settings stay distinct — but the glass
    // is the busiest surface, so the native bar gets the same denser panel
    // the classic iOS bar draws, and the palette's tab tints in place of the
    // system blue and gray every other screen has already left behind.
    mockHighContrast = true;
    const view = render(<TabLayout />);

    expectHighContrastPanel(view);
    expectHighContrastTints(view);
  });

  it("uses the opaque high-contrast bar and palette tints when both options are on", () => {
    mockHighContrast = true;
    mockReduceTransparency = true;
    const view = render(<TabLayout />);

    expectOpaqueNativeBar(view, colors.highContrast);
    expectHighContrastTints(view);
  });

  it("returns to Liquid Glass when Reduce transparency is turned off again", () => {
    mockReduceTransparency = true;
    const view = render(<TabLayout />);
    expectOpaqueNativeBar(view, colors.dark);

    mockReduceTransparency = false;
    view.rerender(<TabLayout />);

    expectLiquidGlass(view);
    expect(view.queryByTestId("tab-bar")).toBeNull();
  });

  it("returns to Liquid Glass when high contrast is turned off again", () => {
    mockHighContrast = true;
    const view = render(<TabLayout />);
    expectHighContrastPanel(view);
    expectHighContrastTints(view);

    mockHighContrast = false;
    view.rerender(<TabLayout />);

    expectLiquidGlass(view);
    expect(view.queryByTestId("tab-bar")).toBeNull();
  });

  it("keeps the opaque bar when high contrast is turned off with Reduce transparency still on", () => {
    // The two toggles are independent: dropping high contrast returns the
    // items to the system tints and the surface to the default palette, but
    // the bar must stay opaque as long as Reduce transparency asks for it.
    mockHighContrast = true;
    mockReduceTransparency = true;
    const view = render(<TabLayout />);
    expectOpaqueNativeBar(view, colors.highContrast);

    mockHighContrast = false;
    view.rerender(<TabLayout />);

    expectOpaqueNativeBar(view, colors.dark);
    expectSystemTints(view);
  });
});

// The high-contrast item tints the native bar passes are the classic bar's
// tints from the same palette, over the same two surfaces the classic bar
// uses, so the token checks above ("Android tab bar surface tokens" for the
// opaque background, "tab bar panel tokens" for the panel over whatever
// scrolls under it) already bound their contrast. This pins that the native
// bar draws exactly those tokens, so a palette edit cannot leave the native
// bar on tints the token checks never saw.
describe("iOS 26 native tab bar tokens", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Platform.OS = "ios";
    mockLiquidGlassAvailable = true;
    mockHighContrast = true;
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    mockLiquidGlassAvailable = false;
    mockHighContrast = false;
    mockReduceTransparency = false;
  });

  it.each([
    ["the high-contrast panel", false],
    ["the opaque high-contrast bar", true],
  ])("keeps the item tints readable on %s", (_surface, reduceTransparency) => {
    mockReduceTransparency = reduceTransparency;
    const props = render(<TabLayout />).getByTestId("native-tabs").props as {
      backgroundColor: string;
      iconColor: { default: string; selected: string };
      labelStyle: { default: { color: string }; selected: { color: string } };
    };

    const surface = parseColor(props.backgroundColor);
    const tints = [
      props.iconColor.default,
      props.iconColor.selected,
      props.labelStyle.default.color,
      props.labelStyle.selected.color,
    ].map((tint) => parseColor(tint).rgb);
    // White is the brightest thing that can scroll under a see-through bar;
    // an opaque bar composites to itself.
    const composited = composite(surface, [255, 255, 255]);

    for (const tint of tints) {
      // WCAG AA for normal text; the tab labels are small text.
      expect(contrastRatio(tint, composited)).toBeGreaterThanOrEqual(4.5);
    }
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

// The translucent panel token: web's surface in every palette, and the iOS
// surface in the high-contrast palette.
describe("tab bar panel tokens", () => {
  const palettes = ["light", "dark", "highContrast"] as const;
  const white: Rgb = [255, 255, 255];

  it.each(palettes)("%s tints the palette background without going opaque", (name) => {
    const palette = colors[name];
    const surface = parseColor(palette.tabBarBackground);

    expect(surface.rgb).toEqual(parseColor(palette.background).rgb);
    expect(surface.alpha).toBeGreaterThan(0);
    expect(surface.alpha).toBeLessThan(1);
  });

  it("is denser in high contrast than in the default palettes", () => {
    // iOS trades its blur for this panel in high contrast to give low-vision
    // users a calmer surface behind the tab controls; a high-contrast token
    // no denser than the everyday one would make that trade pointless.
    const highContrastAlpha = parseColor(colors.highContrast.tabBarBackground).alpha;
    for (const name of ["light", "dark"] as const) {
      expect(highContrastAlpha).toBeGreaterThan(parseColor(colors[name].tabBarBackground).alpha);
    }
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
