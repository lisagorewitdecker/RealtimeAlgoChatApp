import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, type NativeTabsProps } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useAccessibilityOptional } from "@/contexts/AccessibilityContext";
import { useColors } from "@/hooks/useColors";

/**
 * The NativeTabs props the accessibility preferences control. Everything else
 * about the native bar (layout, minimize behaviour, item roles) stays with
 * UIKit.
 */
type NativeTabBarAppearance = Pick<
  NativeTabsProps,
  | "backgroundColor"
  | "blurEffect"
  | "disableTransparentOnScrollEdge"
  | "shadowColor"
  | "tintColor"
  | "iconColor"
  | "labelStyle"
>;

/**
 * iOS 26 draws the native tab bar with Liquid Glass, and expo-router's
 * NativeTabs leaves the bar's background and item tints to the system unless
 * told otherwise. iOS's own Reduce Transparency setting solidifies that glass
 * at the OS level, but the in-app toggles are preferences the system never
 * sees, so the layout has to ask for the same two changes the classic bar
 * makes:
 *
 * - Reduce transparency fills the bar with the opaque palette `background`.
 * - High contrast alone fills it with the palette's denser `tabBarBackground`
 *   panel instead — the surface the classic iOS bar swaps in for its blur —
 *   which stays faintly see-through (high contrast never makes a surface
 *   opaque; that is Reduce transparency's job, and it wins when both are on).
 *   High contrast also colors the tab items with the high-contrast palette
 *   (`primary` when selected, `mutedForeground` otherwise), the tints every
 *   other screen already uses, in place of UIKit's system blue and gray.
 *
 * Either surface is requested with the same four props, because UIKit only
 * leaves Liquid Glass behind when the bar gets a custom background:
 *
 * - `backgroundColor` fills the bar with the chosen palette surface.
 * - `blurEffect="none"` removes the material behind it (UITabBarAppearance's
 *   `backgroundEffect = nil`) so only that surface shows.
 * - `disableTransparentOnScrollEdge` applies the same background at the scroll
 *   edge, where expo-router otherwise clears the bar entirely.
 * - `shadowColor` keeps the classic bar's top border on the bar.
 *
 * With both toggles off none of these are passed, so the tabs keep their
 * default Liquid Glass look and system tints (and the system setting still
 * solidifies the glass on its own). The mapping was checked against
 * expo-router's iOS appearance builders (`__tests__/NativeTabBarAppearance.test.tsx`
 * runs the real ones) and react-native-screens' appearance coordinator; no
 * iOS 26 device is reachable from this workspace, so how UIKit draws the
 * resulting bar is still owed an on-device look. Two things in particular:
 * whether the custom background is drawn full-width or as a filled capsule,
 * and whether unselected icons take `iconColor.default` once the bar has left
 * Liquid Glass (react-native-screens documents that on the glass bar iOS 26
 * applies the item icon color to the selected item only; the label color is
 * an unconditional override either way).
 */
function nativeTabBarAppearance(
  colors: ReturnType<typeof useColors>,
  { highContrast, reduceTransparency }: { highContrast: boolean; reduceTransparency: boolean },
): NativeTabBarAppearance {
  const surface = reduceTransparency
    ? colors.background
    : highContrast
      ? colors.tabBarBackground
      : undefined;

  return {
    ...(surface !== undefined
      ? {
          backgroundColor: surface,
          blurEffect: "none" as const,
          disableTransparentOnScrollEdge: true,
          shadowColor: colors.border,
        }
      : {}),
    ...(highContrast
      ? {
          tintColor: colors.primary,
          iconColor: { default: colors.mutedForeground, selected: colors.primary },
          labelStyle: {
            default: { color: colors.mutedForeground },
            selected: { color: colors.primary },
          },
        }
      : {}),
  };
}

function NativeTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();

  return (
    <NativeTabs {...nativeTabBarAppearance(colors, { highContrast, reduceTransparency })}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{ default: "message.circle", selected: "message.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.circle", selected: "person.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * The classic tab bar is absolutely positioned over the screen. Screens
 * reserve its measured height (`useTabBarContentInset`) because whatever ends
 * up under the bar is covered or dimmed and cannot be tapped.
 *
 * Each platform draws the surface differently:
 *
 * - iOS keeps the bar clear and draws a native blur behind the tab items, so
 *   the chat list shows through it as it scrolls. With high contrast on it
 *   draws the palette's denser `tabBarBackground` panel instead: the blur is
 *   the busiest of the three surfaces, and the high-contrast palette exists
 *   to take visual noise away from low-vision users, so they get the same
 *   panel web draws (still faintly see-through, unlike Reduce transparency).
 * - Android paints the bar itself with the opaque palette background and
 *   draws no background element at all, in every palette.
 * - Web keeps the bar clear on a fixed 84pt height and draws the palette's
 *   translucent `tabBarBackground` panel behind a hairline border.
 *
 * Reduce transparency (the in-app toggle, which follows iOS's system setting
 * until the user changes it) replaces each surface with the opaque palette
 * background and removes the blur or panel, whatever the palette. The bar
 * remains absolutely positioned so the reserved height does not change.
 *
 * expo-blur's Android blur (`blurMethod="dimezisBlurView"`) was evaluated and
 * left out:
 *
 * - It only blurs when a `BlurTargetView` wraps the content and its ref is
 *   passed as `blurTarget`; without one the native side silently falls back
 *   to the same kind of tinted panel (and warns in development). Wiring it
 *   means wrapping every tab screen in that native view and re-targeting the
 *   bar whenever the focused tab changes.
 * - It re-blurs the target on every frame the target redraws (list
 *   scrolling), on the CPU below Android 12 (API 31), which Expo documents as
 *   a performance risk; the API 31+ variant falls back to the tinted panel on
 *   older devices anyway, so the solid bar has to look right regardless.
 * - No Android device or emulator is reachable from this workspace to
 *   measure either path, so the bounded-cost panel ships until a device pass
 *   shows the blur is worth it.
 */
function ClassicTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const isAndroid = Platform.OS === "android";
  // Android's surface is the bar itself, and Reduce transparency makes every
  // platform's bar opaque. Otherwise iOS and web keep the bar clear so the
  // screen shows through the background element drawn behind the tab items.
  const opaqueBar = reduceTransparency || isAndroid;
  // iOS draws the native blur unless high contrast is on, when the palette's
  // denser panel (the one web draws) takes its place.
  const drawsBlur = isIOS && !highContrast;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: opaqueBar ? colors.background : "transparent",
          borderTopWidth: isIOS ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: opaqueBar
          ? undefined
          : () =>
              drawsBlur ? (
                <BlurView
                  intensity={100}
                  tint={isDark ? "dark" : "light"}
                  style={StyleSheet.absoluteFill}
                />
              ) : (
                <View
                  testID="tab-bar-surface"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: colors.tabBarBackground },
                  ]}
                />
              ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="message.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="message-circle" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="user" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, type NativeTabsProps } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useAccessibilityOptional } from "@/contexts/AccessibilityContext";
import { useColors } from "@/hooks/useColors";

/**
 * The NativeTabs props the accessibility preferences control. Everything else
 * about the native bar (layout, minimize behaviour, item roles) stays with
 * UIKit.
 */
type NativeTabBarAppearance = Pick<
  NativeTabsProps,
  | "backgroundColor"
  | "blurEffect"
  | "disableTransparentOnScrollEdge"
  | "shadowColor"
  | "tintColor"
  | "iconColor"
  | "labelStyle"
>;

/**
 * iOS 26 draws the native tab bar with Liquid Glass, and expo-router's
 * NativeTabs leaves the bar's background and item tints to the system unless
 * told otherwise. iOS's own Reduce Transparency setting solidifies that glass
 * at the OS level, but the in-app toggles are preferences the system never
 * sees, so the layout has to ask for the same two changes the classic bar
 * makes:
 *
 * - Reduce transparency fills the bar with the opaque palette `background`.
 * - High contrast alone fills it with the palette's denser `tabBarBackground`
 *   panel instead — the surface the classic iOS bar swaps in for its blur —
 *   which stays faintly see-through (high contrast never makes a surface
 *   opaque; that is Reduce transparency's job, and it wins when both are on).
 *   High contrast also colors the tab items with the high-contrast palette
 *   (`primary` when selected, `mutedForeground` otherwise), the tints every
 *   other screen already uses, in place of UIKit's system blue and gray.
 *
 * Either surface is requested with the same four props, because UIKit only
 * leaves Liquid Glass behind when the bar gets a custom background:
 *
 * - `backgroundColor` fills the bar with the chosen palette surface.
 * - `blurEffect="none"` removes the material behind it (UITabBarAppearance's
 *   `backgroundEffect = nil`) so only that surface shows.
 * - `disableTransparentOnScrollEdge` applies the same background at the scroll
 *   edge, where expo-router otherwise clears the bar entirely.
 * - `shadowColor` keeps the classic bar's top border on the bar.
 *
 * With both toggles off none of these are passed, so the tabs keep their
 * default Liquid Glass look and system tints (and the system setting still
 * solidifies the glass on its own). The mapping was checked against
 * expo-router's iOS appearance builders (`__tests__/NativeTabBarAppearance.test.tsx`
 * runs the real ones) and react-native-screens' appearance coordinator; no
 * iOS 26 device is reachable from this workspace, so how UIKit draws the
 * resulting bar is still owed an on-device look. Two things in particular:
 * whether the custom background is drawn full-width or as a filled capsule,
 * and whether unselected icons take `iconColor.default` once the bar has left
 * Liquid Glass (react-native-screens documents that on the glass bar iOS 26
 * applies the item icon color to the selected item only; the label color is
 * an unconditional override either way).
 */
function nativeTabBarAppearance(
  colors: ReturnType<typeof useColors>,
  { highContrast, reduceTransparency }: { highContrast: boolean; reduceTransparency: boolean },
): NativeTabBarAppearance {
  const surface = reduceTransparency
    ? colors.background
    : highContrast
      ? colors.tabBarBackground
      : undefined;

  return {
    ...(surface !== undefined
      ? {
          backgroundColor: surface,
          blurEffect: "none" as const,
          disableTransparentOnScrollEdge: true,
          shadowColor: colors.border,
        }
      : {}),
    ...(highContrast
      ? {
          tintColor: colors.primary,
          iconColor: { default: colors.mutedForeground, selected: colors.primary },
          labelStyle: {
            default: { color: colors.mutedForeground },
            selected: { color: colors.primary },
          },
        }
      : {}),
  };
}

function NativeTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();

  return (
    <NativeTabs {...nativeTabBarAppearance(colors, { highContrast, reduceTransparency })}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{ default: "message.circle", selected: "message.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.circle", selected: "person.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * The classic tab bar is absolutely positioned over the screen. Screens
 * reserve its measured height (`useTabBarContentInset`) because whatever ends
 * up under the bar is covered or dimmed and cannot be tapped.
 *
 * Each platform draws the surface differently:
 *
 * - iOS keeps the bar clear and draws a native blur behind the tab items, so
 *   the chat list shows through it as it scrolls. With high contrast on it
 *   draws the palette's denser `tabBarBackground` panel instead: the blur is
 *   the busiest of the three surfaces, and the high-contrast palette exists
 *   to take visual noise away from low-vision users, so they get the same
 *   panel web draws (still faintly see-through, unlike Reduce transparency).
 * - Android paints the bar itself with the opaque palette background and
 *   draws no background element at all, in every palette.
 * - Web keeps the bar clear on a fixed 84pt height and draws the palette's
 *   translucent `tabBarBackground` panel behind a hairline border.
 *
 * Reduce transparency (the in-app toggle, which follows iOS's system setting
 * until the user changes it) replaces each surface with the opaque palette
 * background and removes the blur or panel, whatever the palette. The bar
 * remains absolutely positioned so the reserved height does not change.
 *
 * expo-blur's Android blur (`blurMethod="dimezisBlurView"`) was evaluated and
 * left out:
 *
 * - It only blurs when a `BlurTargetView` wraps the content and its ref is
 *   passed as `blurTarget`; without one the native side silently falls back
 *   to the same kind of tinted panel (and warns in development). Wiring it
 *   means wrapping every tab screen in that native view and re-targeting the
 *   bar whenever the focused tab changes.
 * - It re-blurs the target on every frame the target redraws (list
 *   scrolling), on the CPU below Android 12 (API 31), which Expo documents as
 *   a performance risk; the API 31+ variant falls back to the tinted panel on
 *   older devices anyway, so the solid bar has to look right regardless.
 * - No Android device or emulator is reachable from this workspace to
 *   measure either path, so the bounded-cost panel ships until a device pass
 *   shows the blur is worth it.
 */
function ClassicTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const isAndroid = Platform.OS === "android";
  // Android's surface is the bar itself, and Reduce transparency makes every
  // platform's bar opaque. Otherwise iOS and web keep the bar clear so the
  // screen shows through the background element drawn behind the tab items.
  const opaqueBar = reduceTransparency || isAndroid;
  // iOS draws the native blur unless high contrast is on, when the palette's
  // denser panel (the one web draws) takes its place.
  const drawsBlur = isIOS && !highContrast;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: opaqueBar ? colors.background : "transparent",
          borderTopWidth: isIOS ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: opaqueBar
          ? undefined
          : () =>
              drawsBlur ? (
                <BlurView
                  intensity={100}
                  tint={isDark ? "dark" : "light"}
                  style={StyleSheet.absoluteFill}
                />
              ) : (
                <View
                  testID="tab-bar-surface"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: colors.tabBarBackground },
                  ]}
                />
              ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="message.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="message-circle" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="user" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, type NativeTabsProps } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useAccessibilityOptional } from "@/contexts/AccessibilityContext";
import { useColors } from "@/hooks/useColors";

/**
 * The NativeTabs props the accessibility preferences control. Everything else
 * about the native bar (layout, minimize behaviour, item roles) stays with
 * UIKit.
 */
type NativeTabBarAppearance = Pick<
  NativeTabsProps,
  | "backgroundColor"
  | "blurEffect"
  | "disableTransparentOnScrollEdge"
  | "shadowColor"
  | "tintColor"
  | "iconColor"
  | "labelStyle"
>;

/**
 * iOS 26 draws the native tab bar with Liquid Glass, and expo-router's
 * NativeTabs leaves the bar's background and item tints to the system unless
 * told otherwise. iOS's own Reduce Transparency setting solidifies that glass
 * at the OS level, but the in-app toggles are preferences the system never
 * sees, so the layout has to ask for the same two changes the classic bar
 * makes:
 *
 * - Reduce transparency fills the bar with the opaque palette `background`.
 * - High contrast alone fills it with the palette's denser `tabBarBackground`
 *   panel instead — the surface the classic iOS bar swaps in for its blur —
 *   which stays faintly see-through (high contrast never makes a surface
 *   opaque; that is Reduce transparency's job, and it wins when both are on).
 *   High contrast also colors the tab items with the high-contrast palette
 *   (`primary` when selected, `mutedForeground` otherwise), the tints every
 *   other screen already uses, in place of UIKit's system blue and gray.
 *
 * Either surface is requested with the same four props, because UIKit only
 * leaves Liquid Glass behind when the bar gets a custom background:
 *
 * - `backgroundColor` fills the bar with the chosen palette surface.
 * - `blurEffect="none"` removes the material behind it (UITabBarAppearance's
 *   `backgroundEffect = nil`) so only that surface shows.
 * - `disableTransparentOnScrollEdge` applies the same background at the scroll
 *   edge, where expo-router otherwise clears the bar entirely.
 * - `shadowColor` keeps the classic bar's top border on the bar.
 *
 * With both toggles off none of these are passed, so the tabs keep their
 * default Liquid Glass look and system tints (and the system setting still
 * solidifies the glass on its own). The mapping was checked against
 * expo-router's iOS appearance builders (`__tests__/NativeTabBarAppearance.test.tsx`
 * runs the real ones) and react-native-screens' appearance coordinator; no
 * iOS 26 device is reachable from this workspace, so how UIKit draws the
 * resulting bar is still owed an on-device look. Two things in particular:
 * whether the custom background is drawn full-width or as a filled capsule,
 * and whether unselected icons take `iconColor.default` once the bar has left
 * Liquid Glass (react-native-screens documents that on the glass bar iOS 26
 * applies the item icon color to the selected item only; the label color is
 * an unconditional override either way).
 */
function nativeTabBarAppearance(
  colors: ReturnType<typeof useColors>,
  { highContrast, reduceTransparency }: { highContrast: boolean; reduceTransparency: boolean },
): NativeTabBarAppearance {
  const surface = reduceTransparency
    ? colors.background
    : highContrast
      ? colors.tabBarBackground
      : undefined;

  return {
    ...(surface !== undefined
      ? {
          backgroundColor: surface,
          blurEffect: "none" as const,
          disableTransparentOnScrollEdge: true,
          shadowColor: colors.border,
        }
      : {}),
    ...(highContrast
      ? {
          tintColor: colors.primary,
          iconColor: { default: colors.mutedForeground, selected: colors.primary },
          labelStyle: {
            default: { color: colors.mutedForeground },
            selected: { color: colors.primary },
          },
        }
      : {}),
  };
}

function NativeTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();

  return (
    <NativeTabs {...nativeTabBarAppearance(colors, { highContrast, reduceTransparency })}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{ default: "message.circle", selected: "message.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.circle", selected: "person.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * The classic tab bar is absolutely positioned over the screen. Screens
 * reserve its measured height (`useTabBarContentInset`) because whatever ends
 * up under the bar is covered or dimmed and cannot be tapped.
 *
 * Each platform draws the surface differently:
 *
 * - iOS keeps the bar clear and draws a native blur behind the tab items, so
 *   the chat list shows through it as it scrolls. With high contrast on it
 *   draws the palette's denser `tabBarBackground` panel instead: the blur is
 *   the busiest of the three surfaces, and the high-contrast palette exists
 *   to take visual noise away from low-vision users, so they get the same
 *   panel web draws (still faintly see-through, unlike Reduce transparency).
 * - Android paints the bar itself with the opaque palette background and
 *   draws no background element at all, in every palette.
 * - Web keeps the bar clear on a fixed 84pt height and draws the palette's
 *   translucent `tabBarBackground` panel behind a hairline border.
 *
 * Reduce transparency (the in-app toggle, which follows iOS's system setting
 * until the user changes it) replaces each surface with the opaque palette
 * background and removes the blur or panel, whatever the palette. The bar
 * remains absolutely positioned so the reserved height does not change.
 *
 * expo-blur's Android blur (`blurMethod="dimezisBlurView"`) was evaluated and
 * left out:
 *
 * - It only blurs when a `BlurTargetView` wraps the content and its ref is
 *   passed as `blurTarget`; without one the native side silently falls back
 *   to the same kind of tinted panel (and warns in development). Wiring it
 *   means wrapping every tab screen in that native view and re-targeting the
 *   bar whenever the focused tab changes.
 * - It re-blurs the target on every frame the target redraws (list
 *   scrolling), on the CPU below Android 12 (API 31), which Expo documents as
 *   a performance risk; the API 31+ variant falls back to the tinted panel on
 *   older devices anyway, so the solid bar has to look right regardless.
 * - No Android device or emulator is reachable from this workspace to
 *   measure either path, so the bounded-cost panel ships until a device pass
 *   shows the blur is worth it.
 */
function ClassicTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const isAndroid = Platform.OS === "android";
  // Android's surface is the bar itself, and Reduce transparency makes every
  // platform's bar opaque. Otherwise iOS and web keep the bar clear so the
  // screen shows through the background element drawn behind the tab items.
  const opaqueBar = reduceTransparency || isAndroid;
  // iOS draws the native blur unless high contrast is on, when the palette's
  // denser panel (the one web draws) takes its place.
  const drawsBlur = isIOS && !highContrast;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: opaqueBar ? colors.background : "transparent",
          borderTopWidth: isIOS ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: opaqueBar
          ? undefined
          : () =>
              drawsBlur ? (
                <BlurView
                  intensity={100}
                  tint={isDark ? "dark" : "light"}
                  style={StyleSheet.absoluteFill}
                />
              ) : (
                <View
                  testID="tab-bar-surface"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: colors.tabBarBackground },
                  ]}
                />
              ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="message.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="message-circle" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="user" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, type NativeTabsProps } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useAccessibilityOptional } from "@/contexts/AccessibilityContext";
import { useColors } from "@/hooks/useColors";

/**
 * The NativeTabs props the accessibility preferences control. Everything else
 * about the native bar (layout, minimize behaviour, item roles) stays with
 * UIKit.
 */
type NativeTabBarAppearance = Pick<
  NativeTabsProps,
  | "backgroundColor"
  | "blurEffect"
  | "disableTransparentOnScrollEdge"
  | "shadowColor"
  | "tintColor"
  | "iconColor"
  | "labelStyle"
>;

/**
 * iOS 26 draws the native tab bar with Liquid Glass, and expo-router's
 * NativeTabs leaves the bar's background and item tints to the system unless
 * told otherwise. iOS's own Reduce Transparency setting solidifies that glass
 * at the OS level, but the in-app toggles are preferences the system never
 * sees, so the layout has to ask for the same two changes the classic bar
 * makes:
 *
 * - Reduce transparency fills the bar with the opaque palette `background`.
 * - High contrast alone fills it with the palette's denser `tabBarBackground`
 *   panel instead — the surface the classic iOS bar swaps in for its blur —
 *   which stays faintly see-through (high contrast never makes a surface
 *   opaque; that is Reduce transparency's job, and it wins when both are on).
 *   High contrast also colors the tab items with the high-contrast palette
 *   (`primary` when selected, `mutedForeground` otherwise), the tints every
 *   other screen already uses, in place of UIKit's system blue and gray.
 *
 * Either surface is requested with the same four props, because UIKit only
 * leaves Liquid Glass behind when the bar gets a custom background:
 *
 * - `backgroundColor` fills the bar with the chosen palette surface.
 * - `blurEffect="none"` removes the material behind it (UITabBarAppearance's
 *   `backgroundEffect = nil`) so only that surface shows.
 * - `disableTransparentOnScrollEdge` applies the same background at the scroll
 *   edge, where expo-router otherwise clears the bar entirely.
 * - `shadowColor` keeps the classic bar's top border on the bar.
 *
 * With both toggles off none of these are passed, so the tabs keep their
 * default Liquid Glass look and system tints (and the system setting still
 * solidifies the glass on its own). The mapping was checked against
 * expo-router's iOS appearance builders (`__tests__/NativeTabBarAppearance.test.tsx`
 * runs the real ones) and react-native-screens' appearance coordinator; no
 * iOS 26 device is reachable from this workspace, so how UIKit draws the
 * resulting bar is still owed an on-device look. Two things in particular:
 * whether the custom background is drawn full-width or as a filled capsule,
 * and whether unselected icons take `iconColor.default` once the bar has left
 * Liquid Glass (react-native-screens documents that on the glass bar iOS 26
 * applies the item icon color to the selected item only; the label color is
 * an unconditional override either way).
 */
function nativeTabBarAppearance(
  colors: ReturnType<typeof useColors>,
  { highContrast, reduceTransparency }: { highContrast: boolean; reduceTransparency: boolean },
): NativeTabBarAppearance {
  const surface = reduceTransparency
    ? colors.background
    : highContrast
      ? colors.tabBarBackground
      : undefined;

  return {
    ...(surface !== undefined
      ? {
          backgroundColor: surface,
          blurEffect: "none" as const,
          disableTransparentOnScrollEdge: true,
          shadowColor: colors.border,
        }
      : {}),
    ...(highContrast
      ? {
          tintColor: colors.primary,
          iconColor: { default: colors.mutedForeground, selected: colors.primary },
          labelStyle: {
            default: { color: colors.mutedForeground },
            selected: { color: colors.primary },
          },
        }
      : {}),
  };
}

function NativeTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();

  return (
    <NativeTabs {...nativeTabBarAppearance(colors, { highContrast, reduceTransparency })}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{ default: "message.circle", selected: "message.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.circle", selected: "person.circle.fill" }}
        />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * The classic tab bar is absolutely positioned over the screen. Screens
 * reserve its measured height (`useTabBarContentInset`) because whatever ends
 * up under the bar is covered or dimmed and cannot be tapped.
 *
 * Each platform draws the surface differently:
 *
 * - iOS keeps the bar clear and draws a native blur behind the tab items, so
 *   the chat list shows through it as it scrolls. With high contrast on it
 *   draws the palette's denser `tabBarBackground` panel instead: the blur is
 *   the busiest of the three surfaces, and the high-contrast palette exists
 *   to take visual noise away from low-vision users, so they get the same
 *   panel web draws (still faintly see-through, unlike Reduce transparency).
 * - Android paints the bar itself with the opaque palette background and
 *   draws no background element at all, in every palette.
 * - Web keeps the bar clear on a fixed 84pt height and draws the palette's
 *   translucent `tabBarBackground` panel behind a hairline border.
 *
 * Reduce transparency (the in-app toggle, which follows iOS's system setting
 * until the user changes it) replaces each surface with the opaque palette
 * background and removes the blur or panel, whatever the palette. The bar
 * remains absolutely positioned so the reserved height does not change.
 *
 * expo-blur's Android blur (`blurMethod="dimezisBlurView"`) was evaluated and
 * left out:
 *
 * - It only blurs when a `BlurTargetView` wraps the content and its ref is
 *   passed as `blurTarget`; without one the native side silently falls back
 *   to the same kind of tinted panel (and warns in development). Wiring it
 *   means wrapping every tab screen in that native view and re-targeting the
 *   bar whenever the focused tab changes.
 * - It re-blurs the target on every frame the target redraws (list
 *   scrolling), on the CPU below Android 12 (API 31), which Expo documents as
 *   a performance risk; the API 31+ variant falls back to the tinted panel on
 *   older devices anyway, so the solid bar has to look right regardless.
 * - No Android device or emulator is reachable from this workspace to
 *   measure either path, so the bounded-cost panel ships until a device pass
 *   shows the blur is worth it.
 */
function ClassicTabLayout() {
  const colors = useColors();
  const { highContrast, reduceTransparency } = useAccessibilityOptional();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const isAndroid = Platform.OS === "android";
  // Android's surface is the bar itself, and Reduce transparency makes every
  // platform's bar opaque. Otherwise iOS and web keep the bar clear so the
  // screen shows through the background element drawn behind the tab items.
  const opaqueBar = reduceTransparency || isAndroid;
  // iOS draws the native blur unless high contrast is on, when the palette's
  // denser panel (the one web draws) takes its place.
  const drawsBlur = isIOS && !highContrast;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: opaqueBar ? colors.background : "transparent",
          borderTopWidth: isIOS ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: opaqueBar
          ? undefined
          : () =>
              drawsBlur ? (
                <BlurView
                  intensity={100}
                  tint={isDark ? "dark" : "light"}
                  style={StyleSheet.absoluteFill}
                />
              ) : (
                <View
                  testID="tab-bar-surface"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: colors.tabBarBackground },
                  ]}
                />
              ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="message.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="message-circle" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="user" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
