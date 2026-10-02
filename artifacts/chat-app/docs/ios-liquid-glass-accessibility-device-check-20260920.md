# iPhone Liquid Glass tab bar — High contrast and Reduce transparency device check — 2026-09-20

**Result: BLOCKED — the change is implemented and the automated coverage
passes at the reviewed revision, but no iPhone or iOS simulator was reachable
from this workspace, so how iOS 26 draws the requested bar has not been
observed on a device. On-device confirmation is still owed.**

On iOS 26, where `isLiquidGlassAvailable()` is true, the Chat App renders
expo-router's `NativeTabs` and UIKit draws the tab bar. Until this change the
native bar read neither in-app accessibility preference: High contrast
recolored every screen except the tab bar, and the in-app Reduce transparency
toggle (which the classic bar honors on every platform) did nothing there.
`app/(tabs)/_layout.tsx` now maps both preferences onto the same NativeTabs
props:

| Preferences | Bar surface (`backgroundColor` + `blurEffect="none"` + `disableTransparentOnScrollEdge` + `shadowColor`) | Item tints (`tintColor`, `iconColor`, `labelStyle`) |
| --- | --- | --- |
| Both off | Not passed — default Liquid Glass | Not passed — system blue / gray |
| Reduce transparency | Opaque palette `background`, border in palette `border` | Not passed — system blue / gray |
| High contrast | Palette `tabBarBackground` (`rgba(0, 0, 0, 0.9)`, the denser see-through panel the classic iOS bar swaps in for its blur), border `#555555` | `primary` `#60BFFF` selected, `mutedForeground` `#CCCCCC` otherwise |
| Both | Opaque high-contrast `background` `#000000`, border `#555555` | `primary` selected, `mutedForeground` otherwise |

High contrast alone never makes the surface opaque — that is Reduce
transparency's job, and it wins when both are on — matching the classic bar
and web. iOS's own system Reduce Transparency setting keeps solidifying the
glass by itself; it never sees the in-app toggles, which is why the layout
has to ask.

## Environment and device metadata

| Field | Result |
| --- | --- |
| App | Chat App |
| Expo SDK | 57 (`expo` `~57.0.24`) |
| React Native | `0.86.3` |
| `expo-router` | `~57.0.22` (installed 57.0.22) |
| `expo-glass-effect` | `~57.0.3` |
| `react-native-screens` | `~4.26.2` |
| Reviewed revision | the commit that adds this record and the NativeTabs mapping in `app/(tabs)/_layout.tsx` (its parent on `main` was `2667cdbe`, "Report distinct room key storage outage episodes", when the automated coverage below was last run) |
| Target device model | **BLOCKED** — no iPhone or simulator attached |
| Target iOS version | **BLOCKED** — no iPhone or simulator attached (iOS 26 required for the Liquid Glass bar) |
| App container (Expo Go / development build) | **BLOCKED** — no session was available |
| Check timestamp | 2026-09-20T18:52Z |

The one-time availability probe (Linux `x86_64` workspace, re-run today)
found no `adb`, `xcrun`, `maestro`, `java`, `eas`, `idevice_id`, or
`ios-deploy`; no `/dev/bus/usb`; an empty `artifacts/chat-app/.expo/devices.json`;
and zero `NATIVE_SMOKE_*` environment variables — the same result as the
2026-09-18 probe in `ios-reduce-transparency-device-check-20260918.md`. No
device values are inferred from the preview manifest or workflow output.

## Automated coverage at the reviewed revision

Run under the Chat App's Jest projects (`pnpm --filter @workspace/chat-app
exec jest --runInBand --selectProjects iOS -- __tests__/TabLayout.test.tsx
__tests__/NativeTabBarAppearance.test.tsx`; `TabLayout` also runs under the
Android project). Both suites passed on 2026-09-20 (41 tests, 0 failures).

| Behaviour | Test |
| --- | --- |
| Both toggles off: no surface or tint prop is passed, so Liquid Glass and the system tints stay | `TabLayout` › `leaves the default Liquid Glass look and system tints alone while both options are off` |
| Reduce transparency: opaque palette background, no material, kept at the scroll edge, bordered; items keep system tints | `TabLayout` › `asks for an opaque bar while Reduce transparency is on` |
| High contrast alone: the denser (still see-through) high-contrast panel plus palette item tints | `TabLayout` › `swaps the glass for the high-contrast panel and palette tints with high contrast alone` |
| Both on: opaque high-contrast background plus palette item tints | `TabLayout` › `uses the opaque high-contrast bar and palette tints when both options are on` |
| Turning either toggle off restores Liquid Glass; turning high contrast off with Reduce transparency still on keeps the opaque bar | `TabLayout` › `returns to Liquid Glass when Reduce transparency is turned off again`, `returns to Liquid Glass when high contrast is turned off again`, `keeps the opaque bar when high contrast is turned off with Reduce transparency still on` |
| The passed item tints read at WCAG AA (4.5:1) over both high-contrast surfaces, worst case white content under the panel | `TabLayout` › `iOS 26 native tab bar tokens` |
| The props produce the intended `UITabBarAppearance` descriptions in expo-router's real iOS builders for all four states, in both the standard and the scroll-edge appearance | `NativeTabBarAppearance` (all five tests) |

What these prove: the props the layout hands NativeTabs, and the appearance
dictionaries expo-router 57.0.22 derives from them (`tabBarBackgroundColor`,
`tabBarBlurEffect: "none"`, `tabBarShadowColor`, and per-state
`tabBarItemIconColor` / `tabBarItemTitleFontColor` for `normal`, `selected`
and `focused` in the stacked, inline and compact-inline layouts). The
react-native-screens side (`RNSTabBarAppearanceCoordinator.mm`) applies those
verbatim (`RCTConvert UIColor` keeps the panel's alpha; `"none"` becomes
`backgroundEffect = nil`; `tabBarTintColor` becomes `UITabBar.tintColor`).

What they cannot prove: what UIKit draws.

## Device result

| Scenario | Status | Evidence |
| --- | --- | --- |
| High contrast on (Reduce transparency off): the bar shows the `#60BFFF` selected item and `#CCCCCC` unselected items on a near-black panel, with content faintly visible through it | **BLOCKED** | No device |
| Unselected icons take `#CCCCCC` (react-native-screens documents that on the glass bar iOS 26 applies the item icon color to the selected item only; whether the custom-background bar behaves the same is unknown — the label color override is unconditional either way) | **BLOCKED** | No device |
| Reduce transparency on: the bar is solid `#0E1118` (or `#000000` with high contrast) with nothing showing through, including with a short screen where content sits at the scroll edge | **BLOCKED** | No device |
| Whether UIKit draws the opted-out bar full-width (pre-iOS 26 style) or as a filled capsule, and whether the switch back to Liquid Glass when a toggle is turned off happens without a relaunch | **BLOCKED** | No device |

## Manual pass procedure

Run on one iPhone on **iOS 26 or later** (a device on iOS 18 or earlier draws
the classic bar, which `ios-reduce-transparency-device-check-20260918.md`
covers) with a development build of the reviewed revision or stock Expo Go
signed in to the same Expo account as the development server. Record the
device model, exact iOS version, and container. Keep the system
Reduce Transparency setting **off** throughout, or the system solidifies the
glass on its own and masks the in-app behaviour.

1. Sign in and open the Chats tab. Expected: the default Liquid Glass bar with
   system tints. Capture it.
2. Profile → Accessibility: turn **High contrast** on. Return to Chats.
   Expected: the bar is a near-black panel (content faintly visible through
   it when the list scrolls under the bar), the selected item is light blue
   `#60BFFF`, the unselected item and label are light gray `#CCCCCC`. Capture
   both tabs selected in turn. Note whether the unselected *icon* (not only
   the label) took the gray.
3. Turn **Reduce transparency** on as well. Expected: the bar becomes solid
   black with the same tints; nothing shows through, including on the Profile
   tab scrolled to the top. Capture.
4. Turn **High contrast** off (Reduce transparency still on). Expected: the
   bar stays solid, now the palette's `#0E1118`, and the items return to the
   system tints.
5. Turn **Reduce transparency** off. Expected: the default Liquid Glass bar
   returns immediately, without a relaunch. Note any delay or whether it only
   changed after a tab switch or scroll.

Record the outcome of each step in the "Device result" table above with the
device model, iOS version, container, and screenshot file names, and change
the top-level result to **PASS** or **FAIL**. Keep the automated-coverage
section as it is; a device pass does not replace it.

## Follow-up needed for a complete device pass

Repeat this record from an available iPhone on iOS 26. Do not change the
BLOCKED rows to represent a simulator run, the web preview, or the mocked Jest
results. Any device pass for `ios-reduce-transparency-device-check-20260918.md`
on an iOS 26 phone can run this procedure in the same session.
