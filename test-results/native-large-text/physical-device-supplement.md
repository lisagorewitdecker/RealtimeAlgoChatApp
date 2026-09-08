# iOS physical-device supplement blocker

**Status:** Blocked — physical-device evidence not available
**Checked:** 2026-09-03
**Required pass:** One representative iOS device in portrait mode with text
size 140%, High contrast on, and Reduced motion on.

## Environment check

This workspace is running on Linux (`x86_64`), not macOS. The required physical
iOS execution prerequisites are unavailable:

- `xcrun`: missing
- `maestro`: missing
- `eas`: missing
- `ios-deploy` / `idevice_id`: missing
- Prepared iOS release-candidate build ID: not available
- Connected iOS device or booted iOS simulator: not available
- `test-results/native-large-text/ios/`: no evidence produced

The documented command `pnpm --filter @workspace/chat-app
test:native-large-text ios` was attempted on 2026-09-03 and exited with status 2
at its shared prerequisite check: `Required command not found: maestro`. It did
not launch the app or exercise any user flow. Detailed runner evidence is in
`test-results/native-large-text/ios/runner-check.txt`.

The documented command was re-run for this task on 2026-09-03 with the same
result: status 2 at the Maestro prerequisite check. The iOS runner remains
unprepared, so this record continues to be a blocker rather than passing
evidence.

## Result

The manual supplement was **not run**. No device model, iOS version,
keyboard/locale, screenshots, permission observations, keyboard-obscured
actions, clipping results, or font-rasterization results can be recorded from
this runner.

Run this supplement on the prepared macOS iOS runner described in
`artifacts/chat-app/docs/native-large-text-device-check.md`, then store the
timestamped JUnit and screenshot evidence under
`test-results/native-large-text/ios/`. This blocker must remain in place until
that evidence is attached and reviewed.

---

# Android physical-device supplement blocker

**Status:** Blocked — physical-device evidence not available
**Checked:** 2026-09-03
**Required pass:** One representative Android device in portrait mode with text
size 140%, High contrast on, and Reduced motion on.

## Environment check

This workspace is running on Linux (`x86_64`). The required Android execution
prerequisites are unavailable:

- `adb`: missing
- Android SDK/platform tools, emulator, `sdkmanager`, and `avdmanager`: missing
- `maestro`: missing
- Java runtime: missing
- Android SDK environment (`ANDROID_HOME` / `ANDROID_SDK_ROOT`): not set
- `eas`: missing
- Prepared Android release-candidate application/build IDs: not available
- Dedicated verified smoke account: not available to this runner
- Connected Android device or prepared emulator: not available
- `test-results/native-large-text/android/`: runner evidence only; no device
  screenshots or test results were produced

The Android runner bootstrap is present and passed shell syntax validation and
its help-mode check. Its verification mode exited with status 2 at the first
missing SDK prerequisite: `Required command not found: sdkmanager`. The
verification path is read-only and does not install SDK packages or modify AVD
state. Separately, an isolated empty-SDK bootstrap smoke with a temporary local
command-line-tools archive confirmed that `--install-sdk` installs the SDK
packages before checking the newly provided adb/emulator tools and creates the
documented 320x568 mdpi portrait AVD configuration.

The repository runner was also invoked with
`pnpm --filter @workspace/chat-app test:native-large-text android`. It exited
with status 2 at the prerequisite check: `Required command not found: maestro`.
The command therefore did not launch the app or exercise any user flow.

## Result

The Android manual supplement was **not run**. No device model, Android version,
OEM skin, keyboard/locale, screenshots, permission observations,
keyboard-obscured actions, clipping results, or font-rasterization results can
be recorded from this runner.

Run this supplement on the prepared Android runner described in
`artifacts/chat-app/docs/native-large-text-device-check.md`, then store the
timestamped JUnit and screenshot evidence under
`test-results/native-large-text/android/`. This blocker must remain in place
until that evidence is attached and reviewed. The detailed runner evidence is
in `test-results/native-large-text/android/runner-check.txt`.

---

# Cross-platform accessibility evidence review

**Reviewed:** 2026-09-03  
**Decision:** Release blocker remains active — neither platform has reviewed
physical-device evidence.

## Evidence inventory

| Platform | Available evidence              | Physical-device result                                                                                    |
| -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| iOS      | `ios/runner-check.txt` only     | Blocked before simulator/device discovery because the Linux workspace lacks Maestro and iOS tooling       |
| Android  | `android/runner-check.txt` only | Blocked before device discovery because the workspace lacks Maestro, Android SDK tooling, Java, and `adb` |

Neither platform has a timestamped `maestro-results.xml`, JUnit result, native
screenshot set, call-surface screenshot set, device model, OS version,
OEM-keyboard/locale record, or reviewed clipping and keyboard-obscured-action
findings. The runner-check files are environment evidence only; they do not
establish that any app flow passed.

## Shared flow comparison

The documented pass requires the same accessibility settings on both platforms:
portrait orientation, text size 140%, High contrast on, and Reduced motion on.
The following shared flows therefore have no verified platform parity yet:

| Flow                                                          | iOS     | Android | Required review evidence                                                                          |
| ------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------- |
| Sign-in, client-trust verification, and password reset        | Not run | Not run | Wrapping, scroll reachability, focused input above keyboard, and trust/reset actions              |
| Setup with invalid and valid display names                    | Not run | Not run | Error and hint visibility, keyboard-safe Sign out and Enter workspace actions                     |
| Room create/join and room-key warning                         | Not run | Not run | Wrapped retry label and reachable submit action                                                   |
| Room members, long names, multiline composer, and moderation  | Not run | Not run | Header/member actions, composer, send action, and keyboard-obscured controls                      |
| Call permissions, loading/retry states, and embedded controls | Not run | Not run | Camera/microphone prompts, readable blocked copy, retry, and independent call-surface screenshots |
| Profile save and accessibility settings                       | Not run | Not run | Full-page scrolling, saved settings, and reachable save action                                    |

Because every row is unverified on both platforms, this review cannot claim
equivalent coverage or clear the release gate.

## Device-specific follow-up decision

A second Android device or OEM-keyboard pass cannot be assessed until the first
representative Android device produces reviewed evidence. After that run:

- Request a second Android/OEM-keyboard pass if the tested keyboard differs from
  the supported device fleet, or if any focused-input, composer, send, or member
  action is clipped or obscured.
- Keep one representative-device pass as the minimum when the keyboard,
  locale, permission prompts, and all keyboard-open actions match the supported
  fleet and the reviewed screenshots and JUnit results are clean.
- Do not remove this blocker until the Android and iOS evidence sets are both
  attached, reviewed against the same rows above, and any platform-specific
  findings are recorded.
