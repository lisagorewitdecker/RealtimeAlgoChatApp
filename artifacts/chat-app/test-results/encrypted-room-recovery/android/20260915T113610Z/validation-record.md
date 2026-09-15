# Android SDK 57 preview validation record

**Result: BLOCKED — no physical Android handoff was available**

This record covers the SDK 57 development-preview launch boundary described in
`artifacts/chat-app/docs/encrypted-room-recovery-device-check.md`. The public
preview check is recorded separately from the stock Expo Go session boundary.
No emulator, simulator, browser tab, or custom native build was substituted.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 11:36:10 |
| App | Chat App |
| SDK/runtime | Expo SDK 57 (`expo` `~57.0.22`; `@expo/cli` `57.0.20`) |
| Requested client | Stock Expo Go |
| Preview host label | Public Expo preview |
| Device model | **BLOCKED** — no physical Android device was available |
| Android version | **BLOCKED** — no physical Android device was available |
| Expo Go version | **BLOCKED** — no Expo Go session was available |
| Build information | Development preview; no published-build metadata applies |

## Boundary results

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | Public manifest returned HTTP 200; no URL, payload, or host details were retained. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local manifest and bundle probe was not run for this blocked handoff. |
| Expo Go launch on physical Android | **BLOCKED** | No physical phone, device farm, self-hosted Android runner, or Expo Go session was available. |
| Server-side native request evidence | **BLOCKED** | No native Android/Expo Go request was available; the workspace curl was not used as native evidence. |

## Public reachability is not Expo Go launch

The public edge was checked independently of a phone after restarting the Expo
workflow:

```text
GET https://[development Expo host]/manifest.json
HTTP/2 200
content-type: text/html
```

This confirms public preview reachability only. It does not show that stock Expo
Go authenticated, fetched the project as an Android client, or rendered it on a
phone.

## Workspace access check

```text
adb: command not found
emulator: command not found
/dev/bus/usb: absent
artifacts/chat-app/.expo/devices.json: {"devices":[]}
native smoke environment variables: none present
```

These checks explain why this record cannot contain device metadata. They do
not count as a failed Android launch.

## Metro evidence

The restarted Expo workflow logged:

```text
› Using Expo Go
```

No request was made from a physical Android phone, so there is no native
Android/Expo Go request marker to record. In particular, the public workspace
curl probe is not presented as native evidence.

The companion preflight sidecar records the public and local probe statuses
using the current redacted JSON contract. Its phone-only boundaries remain
`NOT_ASSESSED` until a physical Android session supplies that evidence; the
Markdown handoff records those unavailable boundaries as `BLOCKED`.

## Automated companion checks

These workspace checks passed at the current revision, but none replaces the
physical Expo Go launch:

1. Chat App CryptoContext, Room, and secure-storage tests:
   **3 suites, 60 tests passed**.
2. API room socket suite: **1 file, 15 tests passed**.
3. API assistant, security, and profile suites:
   **3 files, 36 tests passed**.

## Next handoff

Use the manual phone, device-farm, or self-hosted-runner route in the
acceptance document. A real operator must provide the phone model, Android
version, Expo Go version, UTC time, a redacted launch screenshot or exact phone
error, and a filtered Metro request showing the native Android/Expo Go client.
Keep this record as a blocked handoff and append a later UTC directory after
that evidence is available.