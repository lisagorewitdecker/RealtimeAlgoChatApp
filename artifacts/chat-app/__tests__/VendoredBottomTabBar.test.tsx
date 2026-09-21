// __tests__/TabLayout.test.tsx checks the classic tab layout against a Tabs
// stand-in, so it never executes expo-router's real navigator. That stand-in
// encodes three assumptions about the react-navigation bottom tab bar that
// expo-router vendors (node_modules/expo-router/build/react-navigation/):
//
// 1. `tabBarBackground` is rendered in a StyleSheet.absoluteFill layer behind
//    the tab items, so the translucent panel sits under the icons and labels.
// 2. `tabBarStyle` is applied last: leaving `height` / `paddingBottom` unset
//    makes the bar TABBAR_HEIGHT_UIKIT (49pt) plus the bottom safe-area inset,
//    while a numeric height (web's 84) replaces that total.
// 3. The measured layout height is published through
//    BottomTabBarHeightCallbackContext / BottomTabBarHeightContext, which
//    hooks/useTabBarContentInset.ts reads so screens can reserve the bar.
//
// An Expo SDK upgrade swaps the vendored copy without failing the stand-in,
// so this suite renders the real vendored views with a stub tab state,
// descriptors and insets. A failure names the vendored file and the
// assumption that broke: re-verify the classic tab bar on a phone
// (app/(tabs)/_layout.tsx) before adjusting the stand-in or the hook.
//
// The suite runs under the iOS Jest project only: the checked code has no
// Android branch (its only platform split is iOS's compact landscape bar), so
// the Android project would repeat the same results.
import type { JSX } from "react";
import { act, render, type RenderResult } from "@testing-library/react-native";
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import {
  BottomTabBar,
  getTabBarHeight,
} from "expo-router/build/react-navigation/bottom-tabs/views/BottomTabBar";
import { BottomTabView } from "expo-router/build/react-navigation/bottom-tabs/views/BottomTabView";
import { BottomTabBarHeightContext } from "expo-router/build/react-navigation/bottom-tabs/utils/BottomTabBarHeightContext";
import type {
  BottomTabDescriptorMap,
  BottomTabNavigationHelpers,
  BottomTabNavigationOptions,
  BottomTabNavigationProp,
} from "expo-router/build/react-navigation/bottom-tabs/types";
import {
  DefaultTheme,
  LinkingContext,
  ThemeProvider,
  type ParamListBase,
  type TabNavigationState,
} from "expo-router/build/react-navigation/native";
import { BottomTabBarHeightContext as PublicBottomTabBarHeightContext } from "expo-router/js-tabs";
import { useTabBarContentInset } from "../hooks/useTabBarContentInset";
import { createAssumptionCheck } from "../test-utils/vendoredAssumption";

// The one thing that keeps the vendored navigator out of Jest: its linking
// helpers require query-string@7, whose decode-uri-component dependency the
// workspace pins (pnpm-workspace.yaml overrides) to an ESM-only release that
// Jest cannot parse. The tab bar only reaches query-string to serialise route
// params into hrefs, and the routes here have none, so an inert stand-in is
// enough. It is `virtual` because the package is not resolvable from this
// app; Jest keys bare-name virtual mocks by name, so the vendored require
// receives it.
jest.mock(
  "query-string",
  () => ({ stringify: () => "", parse: () => ({}) }),
  { virtual: true },
);

// The bar animates itself into view with a natively driven Animated.timing,
// and the React Native Jest preset's NativeAnimatedModule mock finishes every
// native animation on a 16 ms real timer. Left alone, that completion (a
// BottomTabBar state update) fires outside act during the testing library's
// asynchronous cleanup whenever a test lasted longer than the timer, and
// React reports it as an error. Fake timers keep it under this suite's
// control: renderClassicTabs settles it inside act right after rendering, so
// nothing is left to fire between tests.
jest.useFakeTimers();

const VENDORED_BAR = "expo-router/build/react-navigation/bottom-tabs/views/BottomTabBar.js";
const VENDORED_VIEW = "expo-router/build/react-navigation/bottom-tabs/views/BottomTabView.js";
const PUBLIC_TABS = "expo-router/js-tabs (expo-router/build/layouts/Tabs.js)";

// Mirrors the unexported TABBAR_HEIGHT_UIKIT constant in BottomTabBar.js, the
// 49pt that the classic layout documents as the bar's height above the inset.
const TABBAR_HEIGHT_UIKIT = 49;

/** The iPhone safe area the layout's comments reason about. */
const insets: EdgeInsets = { top: 59, bottom: 34, left: 0, right: 0 };

/** A portrait phone frame, so iOS's compact landscape bar does not apply. */
const portraitPhone = { width: 390, height: 844 };

const PANEL_TEST_ID = "tab-bar-background-panel";

/**
 * The classic layout's native `tabBarStyle` shape: absolutely positioned and
 * transparent with a custom top border, and no height or paddingBottom.
 * `elevation: 0` and `borderTopWidth: 1` differ from the navigator's own
 * defaults (8 and a hairline), which is what proves the style is applied last.
 */
const layoutTabBarStyle: ViewStyle = {
  position: "absolute",
  backgroundColor: "transparent",
  borderTopWidth: 1,
  borderTopColor: "#2a2a2e",
  elevation: 0,
};

/**
 * Re-throws an assertion failure with the vendored file and the assumption it
 * contradicts in front of Jest's diff (test-utils/vendoredAssumption.ts).
 */
const checkAssumption = createAssumptionCheck(
  "The Tabs stand-in in __tests__/TabLayout.test.tsx and " +
    "hooks/useTabBarContentInset.ts rely on it: re-verify the classic tab bar " +
    "on a phone (app/(tabs)/_layout.tsx) before updating them.",
);

// --- Stub navigator state -------------------------------------------------

const routes = [
  { key: "index-route", name: "index" },
  { key: "profile-route", name: "profile" },
];

function tabState(): TabNavigationState<ParamListBase> {
  return {
    key: "classic-tabs",
    index: 0,
    routeNames: routes.map((route) => route.name),
    routes,
    type: "tab",
    stale: false,
    history: [{ type: "route", key: routes[0].key }],
    preloadedRouteKeys: [],
  };
}

// The bar only emits tab presses and dispatches the resulting navigation;
// nothing here presses a tab, so the remaining helpers can stay absent.
const navigation = {
  emit: jest.fn(() => ({ defaultPrevented: false })),
  dispatch: jest.fn(),
  getState: tabState,
} as unknown as BottomTabNavigationHelpers & BottomTabNavigationProp<ParamListBase>;

function describeTabs(
  options: BottomTabNavigationOptions,
  Screen: () => JSX.Element,
): BottomTabDescriptorMap {
  return Object.fromEntries(
    routes.map((route) => [
      route.key,
      { route, navigation, options, render: () => <Screen /> },
    ]),
  );
}

/** The options `app/(tabs)/_layout.tsx` gives the classic navigator. */
function layoutOptions(tabBarStyle: ViewStyle): BottomTabNavigationOptions {
  return {
    title: "Chats",
    headerShown: false,
    tabBarStyle,
    tabBarBackground: () => (
      <View testID={PANEL_TEST_ID} style={StyleSheet.absoluteFill} />
    ),
  };
}

function EmptyScreen(): JSX.Element {
  return <View />;
}

/**
 * Renders the vendored tab navigator view, which draws the vendored bar and
 * wires its measured height to the screens. NavigationContainer normally
 * provides the linking options (used to build tab hrefs) and the theme.
 * Returns once the bar's show animation has settled, as it has on a phone by
 * the time anyone looks at the bar.
 */
function renderClassicTabs(
  options: BottomTabNavigationOptions,
  Screen: () => JSX.Element = EmptyScreen,
): RenderResult {
  const view = render(
    <LinkingContext.Provider value={{ options: undefined }}>
      <ThemeProvider value={DefaultTheme}>
        <BottomTabView
          state={tabState()}
          navigation={navigation}
          descriptors={describeTabs(options, Screen)}
          safeAreaInsets={insets}
        />
      </ThemeProvider>
    </LinkingContext.Provider>,
  );
  // Runs the mocked animation completion (see jest.useFakeTimers above)
  // inside act, together with anything an earlier test's unmount queued.
  act(() => {
    jest.runAllTimers();
  });
  return view;
}

// --- Host tree helpers ----------------------------------------------------

type HostNode = {
  type: string;
  props: Record<string, unknown>;
  children: Array<HostNode | string> | null;
};

function hostChildren(node: HostNode): HostNode[] {
  return (node.children ?? []).filter(
    (child): child is HostNode => typeof child !== "string",
  );
}

function findHost(
  nodes: HostNode[],
  matches: (node: HostNode) => boolean,
): HostNode | undefined {
  for (const node of nodes) {
    if (matches(node)) {
      return node;
    }
    const found = findHost(hostChildren(node), matches);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function contains(node: HostNode, target: HostNode): boolean {
  return (
    node === target ||
    hostChildren(node).some((child) => contains(child, target))
  );
}

function styleOf(node: HostNode): ViewStyle {
  return StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) ?? {};
}

/**
 * The vendored bar's root view: the host view whose direct children include
 * the role="tablist" row of tab items.
 */
function classicTabBar(view: RenderResult): HostNode {
  const json = view.toJSON() as HostNode | HostNode[] | null;
  const roots = json == null ? [] : Array.isArray(json) ? json : [json];
  const bar = findHost(roots, (node) =>
    hostChildren(node).some((child) => child.props.role === "tablist"),
  );
  if (!bar) {
    throw new Error(
      `Vendored ${VENDORED_BAR} rendered no view whose children include a ` +
        'role="tablist" row; the tab bar markup changed and every assumption ' +
        "in this suite needs re-verifying on a phone.",
    );
  }
  return bar;
}

// --- Checks ---------------------------------------------------------------

describe(`vendored ${VENDORED_BAR}`, () => {
  describe("getTabBarHeight", () => {
    const heightInputs = (tabBarStyle: ViewStyle, bottom: number) => ({
      state: tabState(),
      descriptors: describeTabs(layoutOptions(tabBarStyle), EmptyScreen),
      dimensions: portraitPhone,
      insets: { ...insets, bottom },
      // The bar passes [options.tabBarStyle, props.style]; the view sends no style.
      style: [tabBarStyle, undefined],
    });

    it.each([0, 20, 34])(
      "returns 49pt + a %dpt bottom inset when tabBarStyle sets no height",
      (bottom) => {
        checkAssumption(
          {
            file: VENDORED_BAR,
            claim:
              "getTabBarHeight returns TABBAR_HEIGHT_UIKIT (49) + insets.bottom when tabBarStyle has no height",
          },
          () => {
            expect(getTabBarHeight(heightInputs(layoutTabBarStyle, bottom))).toBe(
              TABBAR_HEIGHT_UIKIT + bottom,
            );
          },
        );
      },
    );

    it("returns a numeric tabBarStyle height instead of that total", () => {
      checkAssumption(
        {
          file: VENDORED_BAR,
          claim:
            "getTabBarHeight returns a numeric tabBarStyle.height in place of the 49 + inset total",
        },
        () => {
          expect(
            getTabBarHeight(heightInputs({ ...layoutTabBarStyle, height: 84 }, 34)),
          ).toBe(84);
        },
      );
    });
  });

  describe("rendered with the classic layout's options", () => {
    it("still renders the vendored BottomTabBar from BottomTabView", () => {
      const view = renderClassicTabs(layoutOptions(layoutTabBarStyle));
      checkAssumption(
        {
          file: VENDORED_VIEW,
          claim: "BottomTabView renders the vendored BottomTabBar by default",
        },
        () => {
          expect(view.UNSAFE_getAllByType(BottomTabBar)).toHaveLength(1);
        },
      );
    });

    it("draws tabBarBackground in an absoluteFill layer behind the tab items", () => {
      const view = renderClassicTabs(layoutOptions(layoutTabBarStyle));
      const layers = hostChildren(classicTabBar(view));
      const panel = findHost(layers, (node) => node.props.testID === PANEL_TEST_ID);

      checkAssumption(
        {
          file: VENDORED_BAR,
          claim:
            'the tabBarBackground element is rendered in a StyleSheet.absoluteFill layer behind the role="tablist" tab items',
        },
        () => {
          expect(panel).toBeDefined();
          const backgroundLayer = layers.findIndex((layer) =>
            contains(layer, panel as HostNode),
          );
          const tablist = layers.findIndex((layer) => layer.props.role === "tablist");
          expect(backgroundLayer).toBeGreaterThanOrEqual(0);
          // Siblings paint in order: the items row must come after the panel's layer.
          expect(tablist).toBeGreaterThan(backgroundLayer);
          expect(styleOf(layers[backgroundLayer])).toMatchObject({
            ...StyleSheet.flatten(StyleSheet.absoluteFill),
            pointerEvents: "none",
          });
        },
      );
    });

    it("sizes the bar 49pt + bottom inset and keeps the layout's tabBarStyle on top", () => {
      const view = renderClassicTabs(layoutOptions(layoutTabBarStyle));
      const bar = styleOf(classicTabBar(view));

      checkAssumption(
        {
          file: VENDORED_BAR,
          claim:
            "with no height or paddingBottom in tabBarStyle the bar is 49 + insets.bottom tall and pads its items by insets.bottom",
        },
        () => {
          expect(bar.height).toBe(TABBAR_HEIGHT_UIKIT + insets.bottom);
          expect(bar.paddingBottom).toBe(insets.bottom);
        },
      );

      checkAssumption(
        {
          file: VENDORED_BAR,
          claim: "tabBarStyle is applied after the navigator's own bar styles",
        },
        () => {
          expect(bar).toMatchObject(layoutTabBarStyle);
        },
      );
    });

    it("lets a numeric height and paddingBottom in tabBarStyle replace the inset-based values", () => {
      const view = renderClassicTabs(
        layoutOptions({ ...layoutTabBarStyle, height: 84, paddingBottom: 0 }),
      );
      const bar = styleOf(classicTabBar(view));

      checkAssumption(
        {
          file: VENDORED_BAR,
          claim:
            "a numeric height / paddingBottom in tabBarStyle replaces the 49 + inset height and the inset padding",
        },
        () => {
          expect(bar.height).toBe(84);
          expect(bar.paddingBottom).toBe(0);
        },
      );
    });
  });

  describe("measured height", () => {
    function InsetProbe(): JSX.Element {
      // The app's hook: how much space a tab screen reserves above the bar.
      return <Text>{`inset:${useTabBarContentInset()}`}</Text>;
    }

    it("re-exports the vendored BottomTabBarHeightContext that useTabBarContentInset reads", () => {
      checkAssumption(
        {
          file: PUBLIC_TABS,
          claim:
            "expo-router/js-tabs re-exports the vendored BottomTabBarHeightContext instance the navigator populates",
        },
        () => {
          expect(PublicBottomTabBarHeightContext).toBe(BottomTabBarHeightContext);
        },
      );
    });

    it("publishes the bar's layout height to the screens", () => {
      const view = renderClassicTabs(layoutOptions(layoutTabBarStyle), InsetProbe);
      const bar = classicTabBar(view);

      checkAssumption(
        {
          file: VENDORED_VIEW,
          claim:
            "screens start with getTabBarHeight's estimate in BottomTabBarHeightContext before the bar is measured",
        },
        () => {
          expect(
            view.getByText(`inset:${TABBAR_HEIGHT_UIKIT + insets.bottom}`),
          ).toBeTruthy();
        },
      );

      checkAssumption(
        {
          file: `${VENDORED_BAR} and ${VENDORED_VIEW}`,
          claim:
            "the bar reports its onLayout height through BottomTabBarHeightCallbackContext and the screens read it from BottomTabBarHeightContext",
        },
        () => {
          const onLayout = bar.props.onLayout as
            | ((event: LayoutChangeEvent) => void)
            | undefined;
          expect(typeof onLayout).toBe("function");
          // A height the estimate cannot produce, so only a measurement explains it.
          const measured = { x: 0, y: 0, width: portraitPhone.width, height: 91 };
          act(() => {
            onLayout?.({ nativeEvent: { layout: measured } } as LayoutChangeEvent);
          });
          expect(view.getByText("inset:91")).toBeTruthy();
        },
      );
    });
  });
});
