import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Bottom padding that keeps the end of a scrolling tab screen reachable
 * above the tab bar.
 *
 * The classic tab bar in `app/(tabs)/_layout.tsx` is absolutely positioned
 * over the screen. On iOS it is a translucent blur, but on Android and web it
 * is an opaque panel, so content that only reserves the safe-area inset is
 * hidden behind it. The tab navigator publishes the measured height of that
 * bar (safe-area inset included) through `BottomTabBarHeightContext`, which
 * expo-router re-exports from its vendored react-navigation. That vendored
 * copy is the only one in this app: installing `@react-navigation/bottom-tabs`
 * separately would create a second context instance that never receives the
 * value.
 *
 * Outside a classic tab bar (the iOS 26 native tabs, or a screen rendered on
 * its own) there is no measured bar, and the safe-area inset already covers
 * whatever the system draws at the bottom.
 *
 * @param extra additional spacing below the last item, in points.
 */
export function useTabBarContentInset(extra = 0): number {
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const insets = useSafeAreaInsets();
  return (tabBarHeight ?? insets.bottom) + extra;
}
