// On iOS 26 app/(tabs)/_layout.tsx (NativeTabLayout) hands expo-router's
// NativeTabs four surface props (backgroundColor, blurEffect="none",
// disableTransparentOnScrollEdge, shadowColor) when Reduce transparency or
// High contrast is on, plus item tints for High contrast, to take the Liquid
// Glass tab bar out of the glass. __tests__/TabLayout.test.tsx pins those
// props against a NativeTabs stand-in, so it proves what the layout asks for,
// not what UIKit is told. Between the two sit vendored expo-router files that
// nothing in the app renders directly:
//
// 1. NativeTabs.js and NativeTabsNavigatorWrapper (NativeBottomTabsNavigator.js)
//    hand the props on <NativeTabs> to the navigator, which
//    layouts/withLayoutContext.js wraps so that each <NativeTabs.Trigger>
//    becomes a route screen whose options NativeTabTrigger.js derives from the
//    trigger (they win over the navigator's).
// 2. NativeBottomTabsNavigator.js turns the props on <NativeTabs> into the
//    options of every tab (splitting labelStyle / iconColor into a default and
//    a selected option, the selected ones falling back to tintColor).
// 3. appearance.ios.js turns each tab's options into the two
//    UITabBarAppearance descriptions react-native-screens applies verbatim:
//    the standard one, and the scroll-edge one it otherwise clears (no
//    background, no material, transparent shadow) unless
//    disableTransparentOnScrollEdge is set.
// 4. NativeTabsView.ios.js hands those two descriptions to each
//    react-native-screens Tabs.Screen and the host tint to Tabs.Host.
//
// An Expo SDK upgrade replaces all of them at once without failing the
// stand-in: a renamed option, a different scroll-edge default, a dropped
// fallback or an option derived once and never updated would put the glass
// back under a toggle that promises an opaque bar, and no iOS 26 device is
// reachable from this workspace to notice. This suite renders the real layout
// and its real <NativeTabs> through that whole vendored chain, inside the
// minimum of expo-router's root that the chain reads (a navigation container,
// the route node for app/(tabs) and the router store), for each toggle state
// and across toggles on a mounted bar, and pins what reaches
// react-native-screens. A failure names the vendored file and the assumption
// that broke: re-verify the native tab bar on an iPhone running iOS 26 before
// changing the layout or this suite.
//
// iOS Jest project only: the builders and the view under test are the iOS
// implementations.
import React, { createRef, type ContextType } from "react";
import { render, type RenderResult } from "@testing-library/react-native";
import { Platform, type ColorValue } from "react-native";
import { SafeAreaProvider, type EdgeInsets } from "react-native-safe-area-context";
import { Tabs, type TabsScreenAppearanceIOS } from "react-native-screens";
import * as appearanceBuilders from "expo-router/build/native-tabs/appearance.ios";
import { Route, type RouteNode } from "expo-router/build/Route";
import { StoreContext } from "expo-router/build/global-state/storeContext";
import {
  BaseNavigationContainer,
  type NavigationContainerRef,
  type ParamListBase,
} from "expo-router/build/react-navigation/core";
import { DefaultTheme } from "expo-router/build/react-navigation/native";
import colors from "../constants/colors";
import TabLayout from "../app/(tabs)/_layout";
import { createAssumptionCheck } from "../test-utils/vendoredAssumption";

// Same stand-in as __tests__/VendoredBottomTabBar.test.tsx, for the same
// reason: the vendored navigator's linking helpers require query-string@7,
// whose decode-uri-component dependency the workspace pins to an ESM-only
// release Jest cannot parse. Nothing here serialises route params, so an inert
// stand-in is enough; `virtual` because the package is not resolvable from
// this app, and Jest keys bare-name virtual mocks by name.
jest.mock(
  "query-string",
  () => ({ stringify: () => "", parse: () => ({}) }),
  { virtual: true },
);

const VENDORED_NAVIGATOR = "expo-router/build/native-tabs/NativeBottomTabsNavigator.js";
const VENDORED_TRIGGER = "expo-router/build/native-tabs/NativeTabTrigger.js";
const VENDORED_APPEARANCE = "expo-router/build/native-tabs/appearance.ios.js";
const VENDORED_VIEW = "expo-router/build/native-tabs/NativeTabsView.ios.js";
/** Everything between the layout's <NativeTabs> and react-native-screens. */
const VENDORED_CHAIN =
  "expo-router/build/native-tabs (NativeTabs.js, NativeBottomTabsNavigator.js, NativeTabTrigger.js, " +
  "appearance.ios.js, NativeTabsView.ios.js) with expo-router/build/layouts/withLayoutContext.js";

/**
 * Re-throws an assertion failure with the vendored file and the assumption it
 * contradicts in front of Jest's diff (test-utils/vendoredAssumption.ts).
 */
const checkAssumption = createAssumptionCheck(
  "app/(tabs)/_layout.tsx (NativeTabLayout) relies on it to take the iOS 26 " +
    "tab bar out of Liquid Glass for Reduce transparency and High contrast: " +
    "re-verify the native tab bar on an iPhone running iOS 26 (each toggle, at " +
    "rest and with content at the scroll edge) before updating the layout or " +
    "this suite.",
);

// The per-tab options the builders accept (expo-router's NativeTabOptions,
// which the public entry point does not export).
type TabOptions = Parameters<typeof appearanceBuilders.createStandardAppearanceFromOptions>[0];

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
// expo-router/unstable-native-tabs is deliberately real.
jest.mock("expo-router", () => {
  const Tabs = () => null;
  Tabs.Screen = () => null;
  return { Tabs };
});

jest.mock("@/contexts/AccessibilityContext", () => ({
  useAccessibilityOptional: () => ({
    highContrast: mockHighContrast,
    reduceTransparency: mockReduceTransparency,
  }),
}));

type ToggleState = { highContrast: boolean; reduceTransparency: boolean };

function setToggles(state: ToggleState) {
  mockHighContrast = state.highContrast;
  mockReduceTransparency = state.reduceTransparency;
}

// --- The minimum of expo-router's root the vendored chain reads -----------

/** The iPhone safe area the app root's provider reports (app/_layout.tsx). */
const rootInsets: EdgeInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const phoneFrame = { x: 0, y: 0, width: 390, height: 844 };

function EmptyScreen() {
  return null;
}

/**
 * The screen files in app/(tabs) other than the layout. withLayoutContext.js
 * matches the layout's triggers against the route node's children by name
 * and warns about a trigger with no route, which the console guard below
 * turns into a failure: a new tab needs its file listed here as well.
 */
const tabScreens = ["index", "profile"] as const;

/**
 * The route node expo-router builds for app/(tabs). The screens themselves
 * render nothing: only the bar is under test.
 */
const tabsLayoutRoute: RouteNode = {
  type: "layout",
  route: "(tabs)",
  contextKey: "./(tabs)/_layout.tsx",
  dynamic: null,
  loadRoute: () => ({ default: TabLayout }),
  children: tabScreens.map((screen) => ({
    type: "route",
    route: screen,
    contextKey: `./(tabs)/${screen}.tsx`,
    dynamic: null,
    loadRoute: () => ({ default: EmptyScreen }),
    children: [],
  })),
};

type RouterStore = NonNullable<ContextType<typeof StoreContext>>;

// Each focused leaf route reports its state to expo-router's store on render;
// nothing here reads the store back, so recording is enough.
const routerStore = { setFocusedState: () => {} } as Pick<RouterStore, "setFocusedState"> as RouterStore;

let container = createRef<NavigationContainerRef<ParamListBase>>();

/**
 * The real layout under the parts of expo-router's root the vendored chain
 * reads: the navigation container (its theme is what each tab's content
 * reads, as in the app), the route node withLayoutContext.js resolves the
 * triggers against, and the router store the focused route reports to.
 */
function App() {
  return (
    <SafeAreaProvider initialMetrics={{ insets: rootInsets, frame: phoneFrame }}>
      <StoreContext.Provider value={routerStore}>
        <BaseNavigationContainer theme={DefaultTheme} ref={container}>
          <Route node={tabsLayoutRoute} params={{}}>
            <TabLayout />
          </Route>
        </BaseNavigationContainer>
      </StoreContext.Provider>
    </SafeAreaProvider>
  );
}

function mountApp(state: ToggleState): RenderResult {
  setToggles(state);
  container = createRef();
  let view: RenderResult | undefined;
  checkAssumption(
    {
      file: VENDORED_CHAIN,
      claim:
        "the layout's <NativeTabs> renders to completion inside a navigation container, given the route " +
        "node for app/(tabs), the router store and the safe area the app root provides",
    },
    () => {
      view = render(<App />);
    },
  );
  return view as RenderResult;
}

/** Re-renders the mounted app after a toggle change, as the app does. */
function updateApp(view: RenderResult, state: ToggleState) {
  setToggles(state);
  view.rerender(<App />);
}

/** The mounted tabs' route names and keys, in the navigator's order. */
function routes(): { name: string; key: string }[] {
  const state = container.current?.getRootState();
  expect(state).toBeDefined();
  return (state?.routes ?? []).map(({ name, key }) => ({ name, key }));
}

let standardBuilder: jest.SpiedFunction<
  typeof appearanceBuilders.createStandardAppearanceFromOptions
>;
let scrollEdgeBuilder: jest.SpiedFunction<
  typeof appearanceBuilders.createScrollEdgeAppearanceFromOptions
>;
let warn: jest.SpiedFunction<typeof console.warn> | undefined;

/** What react-native-screens was told about one tab, and the options it came from. */
type DescribedTab = {
  name: string;
  options: TabOptions;
  standard: TabsScreenAppearanceIOS;
  scrollEdge: TabsScreenAppearanceIOS;
};

type TabsScreenIOSProps = {
  standardAppearance?: TabsScreenAppearanceIOS;
  scrollEdgeAppearance?: TabsScreenAppearanceIOS;
};

/**
 * Reads back, for every rendered Tabs.Screen, the two appearances it received
 * and the options the builders turned into them: the view passes the
 * builders' return values through unchanged, so each appearance object is
 * matched to the spied call that produced it.
 */
function describedTabs(view: RenderResult): DescribedTab[] {
  const mounted = routes();
  const screens = view.UNSAFE_getAllByType(Tabs.Screen);
  checkAssumption(
    {
      file: VENDORED_VIEW,
      claim: "NativeTabsView renders one react-native-screens Tabs.Screen per tab, in route order",
    },
    () => {
      expect(mounted.length).toBeGreaterThan(0);
      expect(screens).toHaveLength(mounted.length);
    },
  );

  return screens.map((screen, index) => {
    const { name } = mounted[index];
    const ios = (screen.props.ios ?? {}) as TabsScreenIOSProps;
    const standardCall = standardBuilder.mock.results.findIndex(
      (result) => result.type === "return" && result.value === ios.standardAppearance,
    );
    const scrollEdgeCall = scrollEdgeBuilder.mock.results.findIndex(
      (result) => result.type === "return" && result.value === ios.scrollEdgeAppearance,
    );
    checkAssumption(
      {
        file: VENDORED_VIEW,
        claim:
          `the "${name}" tab's Tabs.Screen receives, as ios.standardAppearance and ios.scrollEdgeAppearance, ` +
          "exactly what createStandardAppearanceFromOptions and createScrollEdgeAppearanceFromOptions " +
          "returned for that tab's options",
      },
      () => {
        expect(ios.standardAppearance).toBeDefined();
        expect(ios.scrollEdgeAppearance).toBeDefined();
        expect(standardCall).toBeGreaterThanOrEqual(0);
        expect(scrollEdgeCall).toBeGreaterThanOrEqual(0);
        expect(scrollEdgeBuilder.mock.calls[scrollEdgeCall][0]).toEqual(
          standardBuilder.mock.calls[standardCall][0],
        );
      },
    );
    return {
      name,
      options: standardBuilder.mock.calls[standardCall][0],
      standard: ios.standardAppearance as TabsScreenAppearanceIOS,
      scrollEdge: ios.scrollEdgeAppearance as TabsScreenAppearanceIOS,
    };
  });
}

/** The host-level tint (UITabBar.tintColor) the view hands to Tabs.Host. */
function hostTint(view: RenderResult): ColorValue | undefined {
  let host: ReturnType<RenderResult["UNSAFE_getByType"]> | undefined;
  checkAssumption(
    {
      file: VENDORED_VIEW,
      claim: "NativeTabsView renders exactly one react-native-screens Tabs.Host",
    },
    () => {
      host = view.UNSAFE_getByType(Tabs.Host);
    },
  );
  return (host?.props.ios as { tabBarTintColor?: ColorValue } | undefined)?.tabBarTintColor;
}

function describeBar(state: ToggleState): {
  view: RenderResult;
  tabs: DescribedTab[];
  tint: ColorValue | undefined;
} {
  const view = mountApp(state);
  return { view, tabs: describedTabs(view), tint: hostTint(view) };
}

// --- Assertions -----------------------------------------------------------

const layouts = ["stacked", "inline", "compactInline"] as const;
const itemStates = ["normal", "selected", "focused", "disabled"] as const;

/** The three bar-level values of an appearance, as react-native-screens reads them. */
function barSurface(appearance: TabsScreenAppearanceIOS) {
  return {
    backgroundColor: appearance.tabBarBackgroundColor,
    blurEffect: appearance.tabBarBlurEffect,
    shadowColor: appearance.tabBarShadowColor,
  };
}

/** What UIKit is told about the bar's surface in both appearances. */
function barSurfaces(tab: DescribedTab) {
  return { standard: barSurface(tab.standard), scrollEdge: barSurface(tab.scrollEdge) };
}

/** Both appearances of an opaque bar: one surface, kept at the scroll edge. */
function opaqueSurfaces(surface: { backgroundColor: string; shadowColor: string }) {
  const opaque = { ...surface, blurEffect: "none" };
  return { standard: opaque, scrollEdge: opaque };
}

// expo-router's defaults with no appearance options: the standard appearance
// leaves the bar to UIKit, the scroll-edge one clears it.
const glassSurfaces = {
  standard: { backgroundColor: undefined, blurEffect: undefined, shadowColor: undefined },
  scrollEdge: { backgroundColor: undefined, blurEffect: "none", shadowColor: "transparent" },
};

// The bar background UIKit is given, in both appearances: with the scroll
// edge left to expo-router's default the bar would clear whenever content
// sits at the edge, which for short screens is most of the time.
function expectBarSurface(
  tab: DescribedTab,
  surface: { backgroundColor: string; shadowColor: string },
) {
  checkAssumption(
    {
      file: VENDORED_APPEARANCE,
      claim:
        "a tab whose options carry backgroundColor, blurEffect \"none\", disableTransparentOnScrollEdge and shadowColor " +
        "gets that background, no material (blurEffect \"none\", which react-native-screens turns into backgroundEffect = nil) " +
        "and that shadow in both the standard and the scroll-edge appearance",
    },
    () => {
      expect(barSurfaces(tab)).toEqual(opaqueSurfaces(surface));
    },
  );
}

function expectGlassSurface(tab: DescribedTab) {
  checkAssumption(
    {
      file: VENDORED_APPEARANCE,
      claim:
        "with no appearance options, the standard appearance leaves the bar background, material and shadow " +
        "to UIKit, and the scroll-edge appearance keeps expo-router's own default of no background, " +
        "blurEffect \"none\" and a transparent shadow",
    },
    () => {
      expect(barSurfaces(tab)).toEqual(glassSurfaces);
    },
  );
}

function expectItemTints(tab: DescribedTab, tints: { inactive: string; active: string }) {
  checkAssumption(
    {
      file: VENDORED_APPEARANCE,
      claim:
        "a tab's iconColor and labelStyle.color options tint the normal item state, and its selectedIconColor and " +
        "selectedLabelStyle.color options tint the selected and focused states, as tabBarItemIconColor and " +
        "tabBarItemTitleFontColor in every item layout of both appearances",
    },
    () => {
      for (const appearance of [tab.standard, tab.scrollEdge]) {
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
    },
  );
}

function expectNoItemTints(tab: DescribedTab) {
  checkAssumption(
    {
      file: VENDORED_APPEARANCE,
      claim:
        "a tab without icon or label color options gets no tabBarItemIconColor or tabBarItemTitleFontColor " +
        "in any item state, leaving the item tints to UIKit",
    },
    () => {
      for (const appearance of [tab.standard, tab.scrollEdge]) {
        for (const layout of layouts) {
          for (const state of itemStates) {
            const item = appearance[layout]?.[state] ?? {};
            expect(item).not.toHaveProperty("tabBarItemIconColor");
            expect(item).not.toHaveProperty("tabBarItemTitleFontColor");
          }
        }
      }
    },
  );
}

/** The options the navigator derives from the high-contrast item tints. */
const highContrastItemOptions: TabOptions = {
  tintColor: colors.highContrast.primary,
  iconColor: colors.highContrast.mutedForeground,
  selectedIconColor: colors.highContrast.primary,
  labelStyle: { color: colors.highContrast.mutedForeground },
  selectedLabelStyle: { color: colors.highContrast.primary },
};

/** The option names the layout's appearance props and item tints arrive under. */
const appearanceOptionNames = [
  "backgroundColor",
  "blurEffect",
  "disableTransparentOnScrollEdge",
  "shadowColor",
  "tintColor",
  "iconColor",
  "selectedIconColor",
  "labelStyle",
  "selectedLabelStyle",
] as const satisfies readonly (keyof TabOptions)[];

function expectSurfaceOptions(
  tab: DescribedTab,
  surface: { backgroundColor: string; shadowColor: string },
) {
  checkAssumption(
    {
      file: VENDORED_NAVIGATOR,
      claim:
        "the backgroundColor, blurEffect, disableTransparentOnScrollEdge and shadowColor props on <NativeTabs> " +
        `reach the "${tab.name}" tab's options under the same names, with nothing ${VENDORED_TRIGGER} ` +
        "derives from the trigger overriding them",
    },
    () => {
      expect(tab.options).toMatchObject({
        backgroundColor: surface.backgroundColor,
        blurEffect: "none",
        disableTransparentOnScrollEdge: true,
        shadowColor: surface.shadowColor,
      });
    },
  );
}

function expectHighContrastItemOptions(tab: DescribedTab) {
  checkAssumption(
    {
      file: VENDORED_NAVIGATOR,
      claim:
        "the { default, selected } forms of iconColor and labelStyle on <NativeTabs> become each tab's " +
        "iconColor / selectedIconColor and labelStyle / selectedLabelStyle options, and tintColor is passed through",
    },
    () => {
      expect(tab.options).toMatchObject(highContrastItemOptions);
    },
  );
}

function expectNoAppearanceOptions(tab: DescribedTab) {
  checkAssumption(
    {
      file: VENDORED_NAVIGATOR,
      claim:
        "with none of the appearance props set on <NativeTabs>, no tab option asks for a background, material, " +
        "shadow, host tint or item tint (the layout's way of keeping Liquid Glass and the system tints)",
    },
    () => {
      const set = appearanceOptionNames.filter((option) => tab.options[option] !== undefined);
      expect(set).toEqual([]);
    },
  );
}

describe("iOS 26 native tab bar through expo-router's vendored native tabs", () => {
  const originalPlatform = Platform.OS;

  beforeAll(() => {
    checkAssumption(
      {
        file: VENDORED_APPEARANCE,
        claim:
          "it exports createStandardAppearanceFromOptions and createScrollEdgeAppearanceFromOptions, " +
          `the builders ${VENDORED_VIEW} runs for every tab`,
      },
      () => {
        expect(typeof appearanceBuilders.createStandardAppearanceFromOptions).toBe("function");
        expect(typeof appearanceBuilders.createScrollEdgeAppearanceFromOptions).toBe("function");
      },
    );
    // Call-through spies: NativeTabsView.ios.js looks the builders up on the
    // module at call time, so the spies see the options it hands them.
    standardBuilder = jest.spyOn(appearanceBuilders, "createStandardAppearanceFromOptions");
    scrollEdgeBuilder = jest.spyOn(appearanceBuilders, "createScrollEdgeAppearanceFromOptions");
  });

  afterAll(() => {
    // Optional: a failed export check above leaves the spies uncreated.
    standardBuilder?.mockRestore();
    scrollEdgeBuilder?.mockRestore();
  });

  beforeEach(() => {
    Platform.OS = "ios";
    standardBuilder.mockClear();
    scrollEdgeBuilder.mockClear();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    setToggles({ highContrast: false, reduceTransparency: false });
    // Jest runs this hook even when beforeAll failed and beforeEach never ran.
    const warnings = warn?.mock.calls ?? [];
    warn?.mockRestore();
    warn = undefined;
    // withLayoutContext.js warns about a trigger with no route, the builders
    // warn about (and drop) a blurEffect they no longer support, and the view
    // warns when the icon tints of the two item states disagree; each would
    // change the bar without failing an assertion above.
    checkAssumption(
      {
        file: VENDORED_CHAIN,
        claim: "it renders the layout without a console warning",
      },
      () => {
        expect(warnings).toEqual([]);
      },
    );
  });

  it("keeps the default bar on Liquid Glass: no background, material or item tints reach UIKit", () => {
    const { tabs, tint } = describeBar({ highContrast: false, reduceTransparency: false });

    for (const tab of tabs) {
      expectNoAppearanceOptions(tab);
      expectGlassSurface(tab);
      expectNoItemTints(tab);
    }
    // UITabBar's own tint stays the system's too.
    expect(tint).toBeUndefined();
  });

  it("describes an opaque palette bar in both appearances for Reduce transparency, with system item tints", () => {
    const { tabs, tint } = describeBar({ highContrast: false, reduceTransparency: true });
    const surface = { backgroundColor: colors.dark.background, shadowColor: colors.dark.border };

    for (const tab of tabs) {
      expectSurfaceOptions(tab, surface);
      expectBarSurface(tab, surface);
      expectNoItemTints(tab);
    }
    expect(tint).toBeUndefined();
  });

  it("describes the denser high-contrast panel and palette item tints for High contrast", () => {
    const { tabs, tint } = describeBar({ highContrast: true, reduceTransparency: false });
    const surface = {
      backgroundColor: colors.highContrast.tabBarBackground,
      shadowColor: colors.highContrast.border,
    };
    const tints = {
      inactive: colors.highContrast.mutedForeground,
      active: colors.highContrast.primary,
    };

    for (const tab of tabs) {
      expectSurfaceOptions(tab, surface);
      expectHighContrastItemOptions(tab);
      expectBarSurface(tab, surface);
      expectItemTints(tab, tints);
    }
    // The host-level tint (UITabBar.tintColor) matches the selected items, so
    // anything UIKit tints from the bar rather than the item agrees with them.
    checkAssumption(
      {
        file: VENDORED_VIEW,
        claim: "NativeTabsView passes the tintColor prop on <NativeTabs> to Tabs.Host as ios.tabBarTintColor",
      },
      () => {
        expect(tint).toBe(tints.active);
      },
    );
  });

  it("describes the opaque high-contrast bar with palette item tints when both toggles are on", () => {
    const { tabs, tint } = describeBar({ highContrast: true, reduceTransparency: true });
    const surface = {
      backgroundColor: colors.highContrast.background,
      shadowColor: colors.highContrast.border,
    };
    const tints = {
      inactive: colors.highContrast.mutedForeground,
      active: colors.highContrast.primary,
    };

    for (const tab of tabs) {
      expectSurfaceOptions(tab, surface);
      expectHighContrastItemOptions(tab);
      expectBarSurface(tab, surface);
      expectItemTints(tab, tints);
    }
    expect(tint).toBe(tints.active);
  });

  it("swaps the mounted bar between Liquid Glass and opaque as Reduce transparency is toggled", () => {
    // The app flips the toggle on a mounted bar; a navigator that derived
    // its options once, or a view that memoised the appearances, would pass
    // the fresh mounts above and still leave the glass in place until the
    // next launch.
    const view = mountApp({ highContrast: false, reduceTransparency: false });
    const mounted = routes();
    for (const tab of describedTabs(view)) {
      expectGlassSurface(tab);
    }
    const surface = { backgroundColor: colors.dark.background, shadowColor: colors.dark.border };

    updateApp(view, { highContrast: false, reduceTransparency: true });
    // The same navigator, not a remount: react-navigation keeps route keys
    // for the life of the mounted state.
    expect(routes()).toEqual(mounted);
    checkAssumption(
      {
        file: VENDORED_CHAIN,
        claim:
          "changing the appearance props on a mounted <NativeTabs> re-derives every tab's options and " +
          "appearances, so the bar leaves Liquid Glass when Reduce transparency is turned on",
      },
      () => {
        for (const tab of describedTabs(view)) {
          expect(tab.options).toMatchObject({
            backgroundColor: surface.backgroundColor,
            blurEffect: "none",
            disableTransparentOnScrollEdge: true,
            shadowColor: surface.shadowColor,
          });
          expect(barSurfaces(tab)).toEqual(opaqueSurfaces(surface));
        }
      },
    );

    updateApp(view, { highContrast: false, reduceTransparency: false });
    expect(routes()).toEqual(mounted);
    checkAssumption(
      {
        file: VENDORED_CHAIN,
        claim:
          "removing the appearance props from a mounted <NativeTabs> clears every tab's options and " +
          "appearances, so the bar returns to Liquid Glass when Reduce transparency is turned off",
      },
      () => {
        for (const tab of describedTabs(view)) {
          expect(appearanceOptionNames.filter((option) => tab.options[option] !== undefined)).toEqual([]);
          expect(barSurfaces(tab)).toEqual(glassSurfaces);
        }
      },
    );
  });

  it("describes each tab with the appearance shape react-native-screens reads", () => {
    const { tabs } = describeBar({ highContrast: true, reduceTransparency: true });

    for (const tab of tabs) {
      for (const appearance of [tab.standard, tab.scrollEdge]) {
        checkAssumption(
          {
            file: VENDORED_APPEARANCE,
            claim:
              "each appearance is a react-native-screens TabsScreenAppearanceIOS: the bar's tabBarBackgroundColor, " +
              "tabBarBlurEffect and tabBarShadowColor, plus stacked, inline and compactInline item appearances " +
              "with normal, selected, focused and disabled states",
          },
          () => {
            expect(Object.keys(appearance).sort()).toEqual([
              "compactInline",
              "inline",
              "stacked",
              "tabBarBackgroundColor",
              "tabBarBlurEffect",
              "tabBarShadowColor",
            ]);
            for (const layout of layouts) {
              expect(Object.keys(appearance[layout] ?? {}).sort()).toEqual([
                "disabled",
                "focused",
                "normal",
                "selected",
              ]);
            }
          },
        );
      }
    }
  });

  it("would clear the requested surface at the scroll edge without disableTransparentOnScrollEdge", () => {
    // Documents why the layout's four surface props travel together: the
    // scroll-edge builder drops the background and forces the material off
    // unless the flag is set, so a background on its own is not a solid bar.
    const { tabs } = describeBar({ highContrast: false, reduceTransparency: true });
    const [tab] = tabs;
    expect(tab.options.disableTransparentOnScrollEdge).toBe(true);

    const withoutFlag = appearanceBuilders.createScrollEdgeAppearanceFromOptions({
      ...tab.options,
      disableTransparentOnScrollEdge: undefined,
    });

    checkAssumption(
      {
        file: VENDORED_APPEARANCE,
        claim:
          "the scroll-edge builder drops the background, forces blurEffect \"none\" and makes the shadow " +
          "transparent unless disableTransparentOnScrollEdge is set",
      },
      () => {
        expect(barSurface(withoutFlag)).toEqual(glassSurfaces.scrollEdge);
      },
    );
  });
});
