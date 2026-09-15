# Encrypted-room recovery validation — iOS

**Overall result:** BLOCKED — required physical-device validation could not run  
**Recorded at (UTC):** 2026-09-10T16:51:52Z  
**Source revision used for automated checks:** dddebef13472c705888d52d5dac68cb0f01ec68b  
**Backend target:** Replit development API (`REPLIT_DEV_DOMAIN`); no production data was used.  
**Procedure:** `artifacts/chat-app/docs/encrypted-room-recovery-device-check.md`  
**Previous record:** `../20260903T190238Z/validation-record.md` (BLOCKED, revision `c3abfdbb`)

## Release and device metadata

| Item | Result |
| --- | --- |
| Exact installed release build ID | Not available — no iOS release candidate exists for this workspace (no `eas.json`, no `NATIVE_SMOKE_IOS_BUILD_ID`/`NATIVE_SMOKE_IOS_APP_ID` values) |
| iOS phone A model / iOS version | Not available |
| iOS phone B model / iOS version | Not available |
| iOS device identifiers | Not collected |
| App account A (creator) | Not available to this runner |
| App account B (second phone) | Not available to this runner |
| App account C (non-participant) | Not available to this runner |
| Network profile | Not exercised |
| Screenshots or plaintext room content | None collected |

## Environment check

The re-check at this revision is recorded verbatim in `runner-check.txt`.
The workspace is a Linux `x86_64` container, not a prepared macOS runner:
`xcrun`, `xcodebuild`, `ios-deploy`, `idevice_id`, `ideviceinstaller`,
`maestro`, and `eas` are all missing, there is no USB bus, and the Expo
development server's device registry (`.expo/devices.json`) is empty. No
simulator, Expo Go session, or single-phone smoke test was substituted for the
two-phone pass.

## What changed since the previous record

The source revision now includes the native secure-storage key fix (commit
`dddebef`, 2026-09-10). Before that fix, storage keys contained `:` characters
that `expo-secure-store` rejects, so device identities and room keys were
never persisted on phones. Any iOS candidate built before this revision would
fail the force-close, network-loss, and no-replacement-key rows below for that
known reason and must not be used for this evidence. The automated companion
suites at this revision pass (`automated-regression.txt`), including the
native-storage persistence and key-name coverage added with the fix.

## Physical-device acceptance matrix

| Check | Result | Evidence / blocker |
| --- | --- | --- |
| Phone A creates encrypted room | BLOCKED | No reachable iOS device or installed release build |
| Phone B registers its public key before joining | BLOCKED | No reachable iOS device or installed release build |
| Key envelope exchange and usable decryption | BLOCKED | No two-device session |
| Live/history message and sandbox-state decryption | BLOCKED | No two-device session; no plaintext recorded |
| API/storage boundary holds ciphertext and nonce only | BLOCKED | No device-originated traffic to inspect; automated relay/persistence coverage passed |
| Force-close/reopen restores the persisted key | BLOCKED | Keychain behavior not exercised |
| Temporary network loss and registration retry | BLOCKED | No device/network exercise |
| No unintended replacement room key | BLOCKED | No device/network exercise |
| Identity reset/re-registration and fresh envelope | BLOCKED | No physical identity reset exercise; see limitation below |
| Non-participant cannot obtain a usable envelope | BLOCKED | No physical access-boundary exercise |
| Encrypted-room assistant remains unavailable | BLOCKED | No physical UI/session exercise; server-side rejection covered by automated test |

## Identity-rotation limitation

At this revision the app still has no user-facing device-key reset control.
The only supported reset path is uninstalling and reinstalling the app, which
clears secure storage and registers a new public key; the authenticated
profile route accepts the new key, and automated coverage verifies that
overwrite. A fresh envelope is only delivered while the room creator is
present in the room. This validation did not edit the Keychain and does not
claim a physical identity-rotation pass.

## Resume requirements

Run the procedure above on two representative physical iPhones from a
prepared macOS runner, using an iOS release candidate built from revision
`dddebef` or later, a non-production API environment, and three dedicated
verified accounts. Record only non-sensitive build/device/OS/account-label
metadata, append redacted screenshots and logs under a new
`ios/<UTC timestamp>/` directory, and complete every matrix row before
changing the overall result from `BLOCKED`.
