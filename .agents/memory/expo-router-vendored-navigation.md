---
name: expo-router vendored react-navigation
description: Where tab-bar height and other react-navigation contexts come from in this Expo SDK 57 app, and how to mock them in Jest.
---

**Rule:** Read react-navigation values (tab bar height context, navigation helpers) from expo-router's own re-exports, never by adding `@react-navigation/*` packages.

**Why:** expo-router 57 vendors react-navigation (`expo-router/build/react-navigation/...`), and `@react-navigation/bottom-tabs` is not in the lockfile at all. A separately installed copy would carry its own `BottomTabBarHeightContext` instance that the classic `Tabs` layout never populates, so `useBottomTabBarHeight` would always throw or return nothing. The vendored `BottomTabBarHeightContext` / `useBottomTabBarHeight` are re-exported from `expo-router/js-tabs` (same module as the deprecated `expo-router/tabs` and the `Tabs` export). `useBottomTabBarHeight` throws outside a classic tab navigator (iOS 26 native tabs, standalone renders, tests), so read the context with `useContext` and fall back to the safe-area inset.

**How to apply:** Any tab screen that scrolls under the absolutely positioned classic tab bar needs the measured height (49 + bottom inset on native, 84 on web). In Jest, the real `expo-router/js-tabs` fails to load (ESM `query-string`), so `jest.mock("expo-router/js-tabs", () => ({ BottomTabBarHeightContext: React.createContext(undefined) }))` and wrap the screen in that Provider to assert the reservation.

**Native tabs fallback is inset-only on purpose:** expo-router's iOS `NativeTabsView` wraps each tab in its own `SafeAreaProvider`, so inside iOS 26 native tabs `useSafeAreaInsets().bottom` already includes the system tab bar. Adding a bar-sized constant on top of the inset double-counts it there; only breathing room belongs above the inset.

**Testing the reservation:** the classic bar's default height is 49 + inset by construction, so a test that provides `49 + insets.bottom` cannot tell the measured reservation from a flat `insets.bottom + constant`. Provide a taller bar (or rerender with a new height) to prove the padding tracks the context.
