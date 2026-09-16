import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useColors } from "@/hooks/useColors";

function NativeTabLayout() {
  return (
    <NativeTabs>
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
 * The classic tab bar is absolutely positioned over the screen and see-through
 * on every platform, so the chat list and profile show through it as they
 * scroll. Screens still reserve its measured height (`useTabBarContentInset`)
 * because whatever ends up under the bar is dimmed and cannot be tapped.
 *
 * iOS draws the surface with a native blur. Android and web draw the
 * palette's translucent `tabBarBackground` panel behind a hairline border
 * instead of expo-blur's Android blur (`blurMethod="dimezisBlurView"`), which
 * was evaluated and left out:
 *
 * - It only blurs when a `BlurTargetView` wraps the content and its ref is
 *   passed as `blurTarget`; without one the native side silently falls back
 *   to the same kind of tinted panel (and warns in development). Wiring it
 *   means wrapping every tab screen in that native view and re-targeting the
 *   bar whenever the focused tab changes.
 * - It re-blurs the target on every frame the target redraws (list
 *   scrolling), on the CPU below Android 12 (API 31), which Expo documents as
 *   a performance risk; the API 31+ variant falls back to the tinted panel on
 *   older devices anyway, so the panel has to look right regardless.
 * - No Android device or emulator is reachable from this workspace to
 *   measure either path, so the bounded-cost panel ships until a device pass
 *   shows the blur is worth it.
 */
function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          // The surface comes from `tabBarBackground` on every platform; the
          // bar itself stays clear so the screen shows through it.
          backgroundColor: "transparent",
          borderTopWidth: isIOS ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
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
