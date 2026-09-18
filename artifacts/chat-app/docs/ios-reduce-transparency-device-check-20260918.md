# iPhone Reduce Transparency tab-bar device check — 2026-09-18

**Result: BLOCKED — the automated coverage passes at the current revision,
but no iPhone or iOS simulator was reachable from this workspace, so the live
system-setting behaviour was not observed on a device.**

This check confirms that the Chat App's "Reduce transparency" preference
follows the iOS system setting (Settings → Accessibility → Display & Text Size
→ Reduce Transparency) until the in-app toggle is set by hand, and that the
tab bar redraws solid or see-through immediately when the system setting
changes while the app is in the foreground. Jest exercises the same logic with
a mocked `AccessibilityInfo`; whether iOS actually delivers
`reduceTransparencyChanged` to the running app, and whether the bar repaints
without a restart, can only be seen on a real iPhone.

## Environment and device metadata

| Field | Result |
| --- | --- |
| App | Chat App |
| Expo SDK | 57 (`expo` `~57.0.24`) |
| React Native | `0.86.3` |
| `expo-router` | `~57.0.22` |
| `expo-glass-effect` | `~57.0.3` |
| Reviewed revision | `eba59d1c67dd399e0fb1c333613b6343c750a4a3` |
| Target device model | **BLOCKED** — no iPhone or simulator attached |
| Target iOS version | **BLOCKED** — no iPhone or simulator attached |
| App container (Expo Go / development build) | **BLOCKED** — no session was available |
| Check timestamp | 2026-09-18 UTC |

The one-time availability probe (Linux `x86_64` workspace) found no `adb`,
`xcrun`, `maestro`, `java`, `eas`, `idevice_id`, or `ios-deploy`; no
`/dev/bus/usb`; an empty `artifacts/chat-app/.expo/devices.json`; and zero
`NATIVE_SMOKE_*` environment variables. No device values are inferred from
the preview manifest or workflow output.

The Expo development server was healthy at the time of the check: the public
iOS manifest returned HTTP 200 (2,870 bytes, `createdAt`
`2026-09-18T20:37:35Z`, `runtimeVersion` `exposdk:57.0.0`, signed-in
`extra.expoGo.username` present). A phone with Expo Go could therefore have
opened the preview; none was available here.

## Automated coverage at the reviewed revision

`pnpm --filter @workspace/chat-app exec jest __tests__/AccessibilityContext.test.tsx __tests__/TabLayout.test.tsx __tests__/ProfileModeration.test.tsx`
passed on 2026-09-18 (5 suites across the iOS and Android Jest projects,
152 tests, 0 failures). The cases that cover this behaviour are:

| Behaviour | Test |
| --- | --- |
| System setting applied on launch when no in-app choice is saved | `applies the system reduce-transparency setting during initial load` |
| Saved in-app choice wins over the system setting after a restart | `keeps a saved reduce-transparency choice of false after restart when the system setting is enabled` |
| `reduceTransparencyChanged` flips the preference while running, and is ignored once the in-app toggle was set | `responds to system reduce-transparency changes` |
| Failed system query leaves the option off | `leaves reduce transparency off when the system query fails` |
| Platforms without the setting start off | `starts with reduce transparency off where the platform has no system setting to read` |
| Classic iOS bar swaps the blur for the opaque palette background | `replaces the iOS blur with the opaque palette background` |
| Classic iOS bar stays opaque with high contrast also on | `makes iOS opaque instead of drawing the high-contrast panel when both options are on` |
| Liquid Glass bar asks for an opaque background only while the option is on | `asks for an opaque bar while Reduce transparency is on`, `returns to Liquid Glass when Reduce transparency is turned off again` |

These tests mock `AccessibilityInfo.isReduceTransparencyEnabled` and emit
`reduceTransparencyChanged` themselves. They do **not** prove that iOS
delivers the event to the app, how quickly the bar repaints, or what the
device draws.

## Device result

| Scenario (from the acceptance criteria) | Status | Evidence |
| --- | --- | --- |
| System Reduce Transparency on before launch → classic tab bar opaque, Profile toggle reads "Reduce transparency: on" | **BLOCKED** | No device |
| Toggling the system setting while the app is in the foreground flips the bar between see-through and solid without a restart | **BLOCKED** | No device |
| After setting the in-app toggle by hand, the system setting no longer affects the bar, and the in-app choice survives a relaunch | **BLOCKED** | No device |

## Manual pass procedure

Run this on one iPhone with either stock Expo Go (signed in to the same Expo
account as the development server) or a development build of the current
revision. Record the device model, the exact iOS version, and whether Expo Go
or a development build was used.

Which tab bar the device shows matters for the third scenario:

- On iOS 18 and earlier, or wherever `isLiquidGlassAvailable()` is false, the
  app draws the **classic** tab bar. This is the bar the acceptance criteria
  describe, and every scenario below is observable on it.
- On iOS 26 with a Liquid Glass-capable container, the app draws the native
  Liquid Glass bar and iOS itself solidifies that glass whenever the system
  Reduce Transparency setting is on. Scenarios 1 and 2 remain observable, but
  in scenario 3 the bar cannot become see-through while the system setting is
  on, whatever the in-app toggle says. Record that the Liquid Glass bar was in
  use and treat scenario 3 as verified only through the Profile toggle state
  and its persistence across relaunch.

1. Clear the app's saved preferences so no in-app choice exists: in Expo Go,
   remove the project from the recents list (or delete and reinstall a
   development build). Turn on Settings → Accessibility → Display & Text Size
   → Reduce Transparency before launching. Open the app, sign in, and
   capture the Chats tab with the list scrolled under the tab bar and the
   Profile → Accessibility section. Expected: the bar is solid and the toggle
   reads **On** (VoiceOver: "Reduce transparency: on"). Do not touch the
   in-app toggle.
2. With the app still in the foreground (Split View or the Control Center
   accessibility shortcut avoids backgrounding it; otherwise use the App
   Switcher and return within a few seconds), turn the system setting off,
   then on again. Expected: the bar becomes see-through and then solid again
   each time, with no relaunch. Capture both states. Note any delay longer
   than a second and whether the bar only changed after switching tabs or
   scrolling.
3. Set the in-app toggle by hand (turn it **Off** while the system setting is
   on). Expected: the bar becomes see-through immediately. Change the system
   setting again in both directions. Expected: the bar no longer follows it.
   Force-quit and relaunch the app. Expected: the toggle still reads **Off**
   and the bar is still see-through. Repeat once with the in-app toggle **On**
   and the system setting off; the bar must stay solid across the relaunch.

Record the outcome of each step in the "Device result" table above with the
device model, iOS version, container, and screenshot file names, and change
the top-level result to **PASS** or **FAIL**. Keep the automated-coverage
section as it is; a device pass does not replace it.

## Follow-up needed for a complete device pass

Repeat this record from an available iPhone. Do not change the BLOCKED rows
to represent a simulator run, the web preview, or the mocked Jest results.
