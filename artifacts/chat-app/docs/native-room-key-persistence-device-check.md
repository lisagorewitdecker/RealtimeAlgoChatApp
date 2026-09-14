# Native room-key persistence device check (iPhone / Android)

**Result: automated native-path evidence PASS at this revision; the Expo Go
(iOS) confirmation is PENDING a physical phone, which this workspace cannot
reach.** No simulator, emulator, or web preview was substituted for the phone
rows below.

This record exists because the workspace has no device access (no USB bus,
`xcrun`, `adb`, or Expo device registry). It states what was verified here and
exactly what a person with an iPhone still has to do.

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
| Client for the phone rows | Stock Expo Go (iOS), dev server `exp://<REPLIT_EXPO_DEV_DOMAIN>` |
| Device model / iOS version / Expo Go version | PENDING — no phone reachable from the workspace |

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

## Procedure for the phone rows

1. Keep the `artifacts/chat-app: expo` workflow running; it prints the
   `exp://…expo.worf.replit.dev` link and QR code.
2. On the iPhone, install Expo Go from the App Store, then open the link (or
   scan the QR code with the Camera app) and sign in.
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
