---
name: NativeTabs opaque appearance
description: How to make expo-router's iOS 26 Liquid Glass tab bar opaque from app state, why backgroundColor alone is not enough, and what has not been confirmed on a device.
---

**Rule:** To solidify expo-router's iOS 26 `NativeTabs` bar from an in-app preference, pass `backgroundColor`, `blurEffect="none"` and `disableTransparentOnScrollEdge` together (plus `shadowColor` for the top hairline). Pass none of them to keep the default Liquid Glass.

**Why:** expo-router builds two `UITabBarAppearance` objects per tab. The scroll-edge one drops `backgroundColor` (null), forces `blurEffect` to `none` and makes the shadow transparent unless `disableTransparentOnScrollEdge` is set, so `backgroundColor` alone leaves the bar clear whenever content sits at the scroll edge (which is most of the time for short screens). `blurEffect="none"` is what react-native-screens turns into `backgroundEffect = nil`; a custom background plus nil effect on a bar appearance is UIKit's documented way to opt a bar out of Liquid Glass (WWDC25 "Build a UIKit app with the new design"). iOS's own system Reduce Transparency solidifies the glass by itself and never sees in-app preferences, which is why the layout has to ask.

**Not device-confirmed:** no iOS 26 device or simulator is reachable from this workspace. The chain was verified by reading expo-router's `build/native-tabs/appearance.ios.js` and react-native-screens' `RNSTabBarAppearanceCoordinator.mm`, not by looking at a phone; whether UIKit draws the opaque bar full-width (pre-iOS 26 style) or as a filled capsule is unverified. Tab item tints stay UIKit's defaults (system blue / gray), which read at 5:1 or better on the dark palette background.

**How to apply:** any further NativeTabs appearance work (palette tints, high contrast) goes through the same `NativeTabs` props. The layout suite mocks the navigator and pins the props in both toggle states; if an Expo upgrade is suspected of changing the scroll-edge gating or prop names, run expo-router's real appearance builders against the layout's props rather than trusting the mock.
