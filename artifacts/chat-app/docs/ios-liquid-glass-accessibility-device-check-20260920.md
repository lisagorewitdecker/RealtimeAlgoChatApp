# iPhone Liquid Glass tab bar — accessibility device check — 2026-09-20

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

- **Both off:** Default Liquid Glass; system blue and gray tints.
- **Reduce transparency:** Opaque palette `background`, `border` border,
  and system tints.
- **High contrast:** `tabBarBackground` (`rgba(0, 0, 0, 0.9)`) panel and
  `#555555` border; `primary` (`#60BFFF`) selected and
  `mutedForeground` (`#CCCCCC`) otherwise.
- **Both:** Opaque `background` (`#000000`) and `#555555` border; high-contrast
  item tints.

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
| Coverage revision | Parent `2667cdbe` (last automated-coverage run) |
| Target device model | **BLOCKED** — no iPhone or simulator attached |
| Target iOS version | **BLOCKED** — no device; iOS 26 is required |
| App container | **BLOCKED** — no Expo Go or development-build session |
| Check timestamp | 2026-09-20T18:52Z |

The one-time availability probe (Linux `x86_64` workspace, re-run today)
found no `adb`, `xcrun`, `maestro`, `java`, `eas`, `idevice_id`, or
`ios-deploy`; no `/dev/bus/usb`; an empty `artifacts/chat-app/.expo/devices.json`;
and zero `NATIVE_SMOKE_*` environment variables — the same result as the
2026-09-18 probe in `ios-reduce-transparency-device-check-20260918.md`. No
device values are inferred from the preview manifest or workflow output.

## Automated coverage at the reviewed revision

Run under the Chat App's Jest projects:
`pnpm --filter @workspace/chat-app exec jest --runInBand --selectProjects iOS
-- __tests__/TabLayout.test.tsx __tests__/NativeTabBarAppearance.test.tsx`.
`TabLayout` also runs under the Android project. Both suites passed on
2026-09-20 (41 tests, 0 failures).

- Both toggles off preserve Liquid Glass and system tints (`TabLayout`).
- Reduce transparency uses an opaque, bordered bar and keeps system tints
  (`TabLayout`).
- High contrast alone uses the see-through panel and palette item tints
  (`TabLayout`).
- Both toggles use the opaque high-contrast background and palette tints
  (`TabLayout`).
- Toggle-off cases restore Liquid Glass; Reduce transparency keeps the bar
  opaque when high contrast is turned off (`TabLayout`).
- Item tints meet WCAG AA (4.5:1) on both high-contrast surfaces
  (`TabLayout`).
- `NativeTabBarAppearance` verifies all four states in standard and scroll-edge
  builders (five tests).

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
- **High contrast, Reduce transparency off — BLOCKED:** Check the near-black
  panel, `#60BFFF` selected and `#CCCCCC` unselected items, and visible content.
- **Unselected icon tint — BLOCKED:** `react-native-screens` says iOS 26
  applies the glass-bar icon tint only to the selected item. The custom
  background behavior is unknown; label tint is unconditional.
- **Reduce transparency — BLOCKED:** Check for a solid `#0E1118` bar (or
  `#000000` with high contrast), with no content showing through at the
  scroll edge.
- **Bar shape and toggle response — BLOCKED:** UIKit may draw a full-width bar
  or filled capsule; check whether toggling restores Liquid Glass without
  relaunch.

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
