// On iOS 26 app/(tabs)/_layout.tsx renders expo-router's NativeTabs and UIKit
// draws the Liquid Glass tab bar. The tab screens reserve only the bottom
// safe-area inset above it: hooks/useTabBarContentInset.ts falls back to
// `insets.bottom` when no classic tab bar height is published. That is enough
// for one reason, and it lives in expo-router's vendored native tabs view
// (node_modules/expo-router/build/native-tabs/NativeTabsView.ios.js): the
// view renders each tab's content inside its own SafeAreaProvider from
// react-native-safe-area-context, nested in that tab's react-native-screens
// Tabs.Screen. The provider's native view sits inside the tab's view
// controller, where UIKit's safe area already contains the tab bar, so the
// inset the screen reads covers the bar without the hook adding anything.
//
// Nothing in the app renders that file: __tests__/TabLayout.test.tsx checks
// the layout against a NativeTabs stand-in, and the screen suites mock the
// insets. An Expo SDK upgrade that drops the per-tab provider (leaving the
// screens on the app root's provider, whose bottom inset stops at the home
// indicator) or starts publishing a bar height inside the native tabs would
// pass every suite while the end of each scrolling tab screen becomes
// unreachable behind the glass, or reserves the bar twice. This suite renders
// the real vendored view with the layout's two tabs under the root provider
// the app has, delivers the insets UIKit reports inside a tab to that tab's
// own provider, and checks the screen and the hook read them. A failure names
// the vendored file and the assumption that broke: re-verify the native tabs
// on an iPhone running iOS 26 before touching the hook.
//
// iOS Jest project only: the file under test is the iOS implementation.
import type { JSX } from "react";
import { act, render, type RenderResult } from "@testing-library/react-native";
import { Text } from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
  type EdgeInsets,
} from "react-native-safe-area-context";
import { Tabs } from "react-native-screens";
import { NativeTabsView } from "expo-router/build/native-tabs/NativeTabsView.ios";
import { NativeTabsView as PlatformResolvedNativeTabsView } from "expo-router/build/native-tabs/NativeTabsView";
import type { NativeTabsViewTabItem } from "expo-router/build/native-tabs/types";
import {
  DefaultTheme,
  ThemeProvider,
} from "expo-router/build/react-navigation/native";
import { useTabBarContentInset } from "../hooks/useTabBarContentInset";
import { createAssumptionCheck } from "../test-utils/vendoredAssumption";

// Same stand-in as __tests__/VendoredBottomTabBar.test.tsx, for the same
// reason: the vendored view reads react-navigation's theme from the vendored
// `react-navigation/native` entry, whose linking helpers require
// query-string@7, and the workspace pins its decode-uri-component dependency
// to an ESM-only release Jest cannot parse. Nothing here builds an href, so an
// inert stand-in is enough; `virtual` because the package is not resolvable
// from this app, and Jest keys bare-name virtual mocks by name.
jest.mock(
  "query-string",
  () => ({ stringify: () => "", parse: () => ({}) }),
  { virtual: true },
);

const VENDORED_VIEW = "expo-router/build/native-tabs/NativeTabsView.ios.js";
const VENDORED_NAVIGATOR = "expo-router/build/native-tabs/NativeBottomTabsNavigator.js";

const checkAssumption = createAssumptionCheck(
  "hooks/useTabBarContentInset.ts reserves only the safe-area inset inside the " +
    "iOS 26 native tabs because of it: re-verify the native tabs on an iPhone " +
    "running iOS 26 (app/(tabs)/_layout.tsx, NativeTabLayout: the end of every " +
    "scrolling tab screen must stay reachable above the Liquid Glass tab bar) " +
    "before updating the hook or this suite.",
);

// --- Device model ---------------------------------------------------------

/** A portrait phone frame. */
const phoneFrame = { x: 0, y: 0, width: 390, height: 844 };

/**
 * What the app root's SafeAreaProvider (app/_layout.tsx) reports on an
 * iPhone: the notch above and the home indicator below, no tab bar.
 */
const rootInsets: EdgeInsets = { top: 59, bottom: 34, left: 0, right: 0 };

/**
 * What a tab's own provider receives from UIKit: the home indicator plus the
 * tab bar above it. Deliberately not 34 + 49 (the classic bar's height above
 * the indicator): a hook that added a bar constant to the app root's inset
 * could otherwise pass by coincidence.
 */
const tabInsets: EdgeInsets = { ...rootInsets, bottom: 91 };

/** The extra spacing app/(tabs)/profile.tsx asks for below its last item. */
const EXTRA = 24;

// --- Stub tabs ------------------------------------------------------------

const ROOT = "root";

function probeId(tab: string): string {
  return `insets:${tab}`;
}

/**
 * Stands in for a tab screen: what it reads from the safe area and what the
 * app's hook tells it to reserve.
 */
function InsetProbe({ tab }: { tab: string }): JSX.Element {
  const { bottom } = useSafeAreaInsets();
  const reserved = useTabBarContentInset();
  const spaced = useTabBarContentInset(EXTRA);
  return <Text testID={probeId(tab)}>{JSON.stringify({ bottom, reserved, spaced })}</Text>;
}

type ProbeReading = { bottom: number; reserved: number; spaced: number };

function readProbe(view: RenderResult, tab: string): ProbeReading {
  return JSON.parse(view.getByTestId(probeId(tab)).props.children as string) as ProbeReading;
}

/**
 * The tabs NativeBottomTabsNavigator.js derives from the layout's two
 * triggers (options as NativeTabTrigger.js converts them, contentRenderer
 * rendering the route's screen).
 */
const layoutTabs: NativeTabsViewTabItem[] = [
  {
    routeKey: "index-route",
    name: "index",
    options: {
      title: "Chats",
      icon: { sf: "message.circle" },
      selectedIcon: { sf: "message.circle.fill" },
      hidden: false,
    },
    contentRenderer: () => <InsetProbe tab="index" />,
  },
  {
    routeKey: "profile-route",
    name: "profile",
    options: {
      title: "Profile",
      icon: { sf: "person.circle" },
      selectedIcon: { sf: "person.circle.fill" },
      hidden: false,
    },
    contentRenderer: () => <InsetProbe tab="profile" />,
  },
];
const [chatsTab, profileTab] = layoutTabs;

/**
 * Renders the vendored view the way it sits in the app: under the root
 * SafeAreaProvider (given the insets it has received from native by the time
 * the tabs mount) and react-navigation's theme, which NavigationContainer
 * provides and the view uses for each tab's background. A probe outside the
 * tabs shows what the root provider hands to screens that are not in a tab.
 */
function renderNativeTabs(): RenderResult {
  return render(
    <SafeAreaProvider initialMetrics={{ insets: rootInsets, frame: phoneFrame }}>
      <InsetProbe tab={ROOT} />
      <ThemeProvider value={DefaultTheme}>
        <NativeTabsView
          focusedIndex={0}
          provenance={0}
          tabs={layoutTabs}
          onTabChange={() => {}}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

// --- Rendered tree helpers ------------------------------------------------

type TestInstance = ReturnType<RenderResult["UNSAFE_getAllByType"]>[number];

/** The rendered tab screens, keyed by the tab's routeKey. */
function tabScreens(view: RenderResult): Map<string, TestInstance> {
  return new Map(
    view
      .UNSAFE_getAllByType(Tabs.Screen)
      .map((screen) => [screen.props.screenKey as string, screen]),
  );
}

/** The Tabs.Screen the vendored view renders for a tab. */
function tabScreen(view: RenderResult, tab: NativeTabsViewTabItem): TestInstance {
  const screen = tabScreens(view).get(tab.routeKey);
  checkAssumption(
    {
      file: VENDORED_VIEW,
      claim: `NativeTabsView renders the "${tab.name}" tab as a react-native-screens Tabs.Screen whose screenKey is the tab's routeKey`,
    },
    () => {
      expect(screen).toBeDefined();
    },
  );
  return screen as TestInstance;
}

/** The SafeAreaProvider the vendored view renders inside a tab's Tabs.Screen. */
function tabProvider(view: RenderResult, tab: NativeTabsViewTabItem): TestInstance {
  const providers = tabScreen(view, tab).findAllByType(SafeAreaProvider);
  checkAssumption(
    {
      file: VENDORED_VIEW,
      claim:
        `the "${tab.name}" tab's Tabs.Screen contains exactly one SafeAreaProvider from react-native-safe-area-context ` +
        "(inside the tab, so its native view gets the safe area UIKit reports there, tab bar included)",
    },
    () => {
      expect(providers).toHaveLength(1);
    },
  );
  return providers[0];
}

/** The host views under `root` carrying the given testID. */
function hostsWithTestId(root: TestInstance, testID: string): TestInstance[] {
  return root.findAll(
    (node) => typeof node.type === "string" && node.props.testID === testID,
  );
}

/**
 * Delivers the insets the native side reports for a provider's view: the
 * onInsetsChange event of the host view under the SafeAreaProvider, which is
 * how react-native-safe-area-context learns the safe area on a phone.
 */
function deliverInsets(provider: TestInstance, insets: EdgeInsets): void {
  const [nativeProvider] = provider.findAll(
    (node) =>
      typeof node.type === "string" && typeof node.props.onInsetsChange === "function",
  );
  expect(nativeProvider).toBeDefined();
  act(() => {
    (nativeProvider.props.onInsetsChange as (event: unknown) => void)({
      nativeEvent: { insets, frame: phoneFrame },
    });
  });
}

// --- Checks ---------------------------------------------------------------

describe(`vendored ${VENDORED_VIEW}`, () => {
  it("is the view the native tabs navigator renders on iOS", () => {
    checkAssumption(
      {
        file: VENDORED_NAVIGATOR,
        claim:
          "NativeBottomTabsNavigator renders ./NativeTabsView, which resolves to NativeTabsView.ios.js on iOS",
      },
      () => {
        // The iOS Jest project resolves platform files the way Metro's iOS
        // build does, so the bare module is the .ios implementation...
        expect(PlatformResolvedNativeTabsView).toBe(NativeTabsView);
        // ...and loading the navigator in a fresh module registry must reach
        // that module (the stand-in records the require; nothing renders).
        let navigatorRequiredView = false;
        try {
          jest.isolateModules(() => {
            jest.doMock("expo-router/build/native-tabs/NativeTabsView", () => {
              navigatorRequiredView = true;
              return jest.requireActual("expo-router/build/native-tabs/NativeTabsView.ios");
            });
            require("expo-router/build/native-tabs/NativeBottomTabsNavigator");
          });
        } finally {
          jest.dontMock("expo-router/build/native-tabs/NativeTabsView");
        }
        expect(navigatorRequiredView).toBe(true);
      },
    );
  });

  it("renders one react-native-screens Tabs.Screen per tab, keyed by routeKey", () => {
    const view = renderNativeTabs();
    checkAssumption(
      {
        file: VENDORED_VIEW,
        claim:
          "NativeTabsView renders each tab as a react-native-screens Tabs.Screen whose screenKey is the tab's routeKey",
      },
      () => {
        expect([...tabScreens(view).keys()]).toEqual(layoutTabs.map((tab) => tab.routeKey));
      },
    );
  });

  it("wraps each tab's content in its own SafeAreaProvider inside that tab's Tabs.Screen", () => {
    const view = renderNativeTabs();
    for (const tab of layoutTabs) {
      const provider = tabProvider(view, tab);
      checkAssumption(
        {
          file: VENDORED_VIEW,
          claim: `the "${tab.name}" tab's content is rendered inside that SafeAreaProvider`,
        },
        () => {
          expect(hostsWithTestId(provider, probeId(tab.name))).toHaveLength(1);
        },
      );
    }
  });

  it("lets each tab's screen read the insets UIKit reports inside that tab, with nothing added on top", () => {
    const view = renderNativeTabs();
    const chatsProvider = tabProvider(view, chatsTab);

    // Until its own native view reports, a nested provider hands down what its
    // parent has, so every probe starts on the root insets.
    expect(readProbe(view, chatsTab.name)).toEqual({
      bottom: rootInsets.bottom,
      reserved: rootInsets.bottom,
      spaced: rootInsets.bottom + EXTRA,
    });

    deliverInsets(chatsProvider, tabInsets);

    checkAssumption(
      {
        file: VENDORED_VIEW,
        claim:
          "the SafeAreaProvider inside a tab's Tabs.Screen is the one that tab's content reads: insets delivered to it reach useSafeAreaInsets in the screen, and neither the app root nor the other tab sees them",
      },
      () => {
        expect(readProbe(view, chatsTab.name).bottom).toBe(tabInsets.bottom);
        expect(readProbe(view, profileTab.name).bottom).toBe(rootInsets.bottom);
        expect(readProbe(view, ROOT).bottom).toBe(rootInsets.bottom);
      },
    );

    checkAssumption(
      {
        file: `${VENDORED_VIEW} and ${VENDORED_NAVIGATOR}`,
        claim:
          "no BottomTabBarHeightContext value is published inside the native tabs, so useTabBarContentInset reserves the tab's bottom inset plus only the requested extra spacing (the inset already contains the tab bar; adding a bar height would reserve it twice)",
      },
      () => {
        expect(readProbe(view, chatsTab.name)).toEqual({
          bottom: tabInsets.bottom,
          reserved: tabInsets.bottom,
          spaced: tabInsets.bottom + EXTRA,
        });
      },
    );
  });
});
