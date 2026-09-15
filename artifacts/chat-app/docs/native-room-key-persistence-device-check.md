# Native room-key persistence device check (iPhone / Android)

**Result: automated native-path evidence PASS at this revision; the Expo Go
(iOS) confirmation is PENDING a physical phone, which this workspace cannot
reach.** No simulator, emulator, or web preview was substituted for the phone
rows below.

This record exists because the workspace has no device access (no USB bus,
`xcrun`, `adb`, or Expo device registry). It states what was verified here and
exactly what a person with an iPhone still has to do.

## SDK 57 iOS preview handoff

The development-preview launch boundary is separate from the
release-candidate persistence checks below. It must use a physical iPhone
running the stock Expo Go app; a browser, iOS simulator, Android device, or
published build is not a substitute.

1. Keep the `artifacts/chat-app: expo` workflow running and give the operator
   the current public Expo preview link or QR code. The operator installs stock
   Expo Go from the App Store, records the iPhone model, iOS version, and Expo
   Go version, then opens the link in Expo Go on a fresh app launch.
2. Set `EXPO_DEV_REQUEST_LOG=1` in the development environment and restart the
   managed Chat App/Expo workflow. After Metro is ready, run:

   ```sh
   pnpm --filter @workspace/chat-app run validate:preview-startup -- \
     --platform ios \
     --record-output /tmp/ios-preview-preflight.json
   ```

   This preflight checks the public Expo manifest endpoint through the managed
   `REPLIT_EXPO_DEV_DOMAIN` with the iOS Expo manifest header and then probes
   the iOS manifest and bundle locally.
   Copy its four boundary values into the record template below. The public
   result is reachability evidence only; it is not evidence that Expo Go opened
   on an iPhone.
3. Do not start the phone session unless
   `public_manifest_reachability=PASS`. A non-200 public manifest response is a
   public-edge failure: repair or restart the managed workflow and rerun the
   preflight. It is not a `BLOCKED` result for missing iPhone evidence.
4. The operator opens the fresh preview in stock Expo Go, waits for the Chat App
   landing screen, and captures a redacted screenshot. Treat the phone launch
   as observed only when both the iPhone screen and filtered server-side native
   request evidence are available. The native request should identify an iOS
   or Expo Go client marker and `platform=ios`; do not retain a full host, URL,
   credential, account identifier, or message.
5. If Expo Go cannot launch, record the exact iPhone error and a redacted
   screenshot. A workspace request, browser tab, local probe, or Metro startup
   line proves public reachability or workflow readiness only. It does not
   prove an Expo Go session launched.
6. Save `validation-record.md` under
   `test-results/encrypted-room-recovery/ios/<UTC timestamp>/`. Keep all four
   rows below even when one is `FAIL`, `BLOCKED`, or `NOT_ASSESSED`. A public
   `PASS` with physical-device or server-evidence `BLOCKED` means the public
   edge worked but no iPhone evidence was available. When no physical route is
   available, write `BLOCKED` rows rather than inventing device values.
   Because the repository ignores artifact-level `test-results/`, force-add the
   completed record with `git add -f` so it is retained; do not create a
   duplicate copy under `docs/`.

### iOS preview handoff record template

Copy this table into the timestamped `validation-record.md` and replace each
status and evidence note. The first two rows come from the public/local
preflight; the last two require the physical iPhone session and filtered
server-side logs.

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS / FAIL | Preflight `publicManifestReachability` result; status and byte count only |
| Local handoff probe (manifest and bundle) | PASS / FAIL / NOT_RUN | Preflight `localHandoffProbe` result; no URL or launch payload |
| Expo Go launch on physical iPhone | PASS / FAIL / BLOCKED | iPhone screen reached the landing screen, or the exact phone error |
| Server-side native request evidence | PASS / FAIL / BLOCKED | Filtered Metro/API marker with `platform=ios` and an Expo Go client or user-agent; no full host, URL, credentials, or message content |

The local handoff probe is a workspace request against Metro. It proves that
the manifest and bundle can be fetched locally, not that Expo Go launched on a
phone. The server-side native request row is the separate proof that the
iPhone made the request. A public-edge `FAIL` means the phone handoff should
not start; it is not a substitute for, or evidence of, a missing phone
session.

## Background

`expo-secure-store` (installed `57.0.4`) rejects any key name outside
`/^[\w.-]+$/` before touching the keychain or keystore. The app's logical keys
use `:` separators, so on phones every device-identity and room-key write and
read threw, the app fell back to a fresh in-memory identity on each launch, and
creating a room showed "Room key could not be saved". Web (localStorage) never
had the problem, which is why browser end-to-end runs never caught it.

The fix (`lib/secureStorageKey.ts`, in the tree since 2026-09-10) encodes every
native key deterministically and injectively; web keys are unchanged, so no
browser data needs migrating. The 2026-09-14 revision adds the missing
diagnostics and test coverage listed below.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-14 16:30 |
| App | Chat App |
| SDK/runtime | Expo SDK 57 (`expo` `~57.0.22`), `expo-secure-store` `57.0.4` |
| Revision | working tree of 2026-09-14 on top of `61a854d` |
| Client for the phone rows | Stock Expo Go (iOS, Android), dev server `exp://<REPLIT_EXPO_DEV_DOMAIN>` |
| Device model / OS version / Expo Go version | PENDING — no phone reachable from the workspace |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Every native storage key satisfies the secure-store rule | PASS | Both secure-store test doubles call `test-utils/secureStoreKeyRule.ts`; disabling the encoding fails 25 tests across the two provider suites. |
| The rule matches the installed module | PASS | `secureStorageKey.test.ts` runs the real `expo-secure-store` validation: logical keys rejected before any native call, encoded keys accepted. |
| Odd identifiers (apostrophes, slashes, spaces, colons, non-ASCII, emoji) save and restore | PASS | `CryptoContext.test.tsx` — account and room IDs outside the alphabet round-trip through the native path across a remount. |
| Device identity and room keys survive a remount on the native path | PASS | `CryptoContext.test.tsx` remount tests (same public key, same room key, no regenerated entries). |
| Native save failures log their cause; retry UX unchanged | PASS | Device-identity load/save, room-key save, and identity-reset save each log the underlying error; tests assert the message and the unchanged retry status. |
| Existing web users keep their data | PASS (by construction) | Web reads and writes still use the original logical keys; nothing was renamed, so there is nothing to migrate. |
| Chat App tests, typecheck, release preflight | PASS | 22 suites / 179 tests, `tsc --noEmit` clean, `preflight:release` passed on 2026-09-14. |
| Creating a room in stock Expo Go on an iPhone opens the room without the secure-storage warning | PENDING | Requires a physical iPhone; procedure below. |
| Force-quit and relaunch keeps the device identity and the room key | PENDING | Requires a physical iPhone; procedure below. |
| The same two checks in stock Expo Go on a physical Android phone | PENDING | Same procedure; the keystore applies the same key-name rule. |

## Procedure for the phone rows

The rows below are release-candidate persistence checks, not the preview
handoff rows above. A public manifest `PASS`, a local probe `PASS`, or a
server-side request without a physical iPhone does not turn either pending
release-candidate row into evidence.

1. Keep the `artifacts/chat-app: expo` workflow running; it prints the
   `exp://…expo.worf.replit.dev` link and QR code.
2. On the phone, install Expo Go (App Store or Play Store), then open the link
   (or scan the QR code with the Camera app) and sign in.
3. Create a room whose name contains an apostrophe and a slash (for example
   `Ana's team / design`). Expected: the room opens, no "Room key could not be
   saved" message, and a sent message appears.
4. Force-quit Expo Go, reopen the same link, and open the same room. Expected:
   the room opens and the earlier message is still readable without any key
   reset prompt. The Profile screen's device-encryption card shows the same
   key fingerprint as before the relaunch (note it down in step 3).
5. Fill in the device model, iOS version, and Expo Go version above and flip
   the two PENDING rows to PASS or FAIL. For a FAIL, copy the Metro console
   line that starts with `Device encryption identity could not be` or
   `Room encryption key could not be` — that line names the real cause.
