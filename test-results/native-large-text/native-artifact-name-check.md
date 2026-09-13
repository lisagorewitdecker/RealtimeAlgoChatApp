# Native release artifact app-name verification

**Status:** Blocked — native release artifacts and representative devices are
not available in this workspace

**Checked (UTC):** 2026-09-03

## Source-level resolved configuration

The Expo config resolver completed successfully on this Linux workspace:

- Resolved app name: `RealtimeAlgoChatApp Studio`
- Resolved iOS camera permission text: `RealtimeAlgoChatApp Studio uses your
  camera for video calls.`
- Resolved iOS microphone permission text: `RealtimeAlgoChatApp Studio uses
  your microphone for voice and video calls.`
- Compatibility slug: `chat-app` — unchanged
- Compatibility scheme: `chat-app` — unchanged

The same values are enforced by
`artifacts/chat-app/scripts/validate-branding.mjs`, which is included in the
chat-app test and build paths.

The mobile release workflow now performs a second check against the installed
release candidates. The iOS job converts the installed app's `Info.plist` to
JSON and the Android job reads the installed APK's compiled manifest with
`aapt2`. Each platform writes `native-branding-check.md`, `native-info.json`,
and the candidate build ID into its uploaded run directory. A mismatch fails
the platform job before the large-text smoke flow can pass.

## Native artifact inspection

Native release candidates could not be built or installed from this runner:

- Host: Linux x86_64
- iOS: `xcrun` and `xcodebuild` unavailable; no prepared Mac, iOS build, or
  device/simulator
- Android: `adb`, emulator tooling, and Android SDK unavailable; no prepared
  Android build or device/emulator
- EAS CLI: unavailable

Therefore no installed launcher label, Android-generated permission prompt, iOS
permission prompt, device model, OS version, or screenshot evidence was
produced. The source-level values must not be treated as a substitute for the
required native artifact inspection.

## Resume requirements

On prepared iOS and Android release runners:

1. Build and install the release candidates.
2. Confirm the installed launcher label is `RealtimeAlgoChatApp Studio`.
3. Trigger camera and microphone permissions and confirm the prompts use the
   approved product name.
4. Record device/OS details and screenshots, then replace this blocked result
   with the reviewed native evidence.

The automated metadata report does not replace this manual supplement: native
permission dialogs and launcher rendering still require representative-device
confirmation.