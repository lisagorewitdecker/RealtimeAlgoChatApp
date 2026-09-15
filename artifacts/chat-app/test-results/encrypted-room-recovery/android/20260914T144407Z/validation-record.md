# Android SDK 57 preview validation record

**Result: BLOCKED — no physical Android handoff was available**

This is the timestamped evidence record for the SDK 57 preview route described
in `artifacts/chat-app/docs/encrypted-room-recovery-device-check.md`. It
records the public-edge check separately from the Expo Go session boundary.
No emulator, simulator, browser tab, or custom native build was substituted.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-14 14:44:07 |
| App | Chat App |
| SDK/runtime | Expo SDK 57 (`expo` `~57.0.22`; `@expo/cli` `57.0.20`) |
| Requested client | Stock Expo Go |
| Device model | **BLOCKED** — no physical Android device was available |
| Android version | **BLOCKED** — no physical Android device was available |
| Expo Go version | **BLOCKED** — no Expo Go session was available |
| Build information | Development preview; no published-build metadata applies |

## Boundary results

| Boundary | Status | Evidence |
| --- | --- | --- |
| SDK 57 workflow reached Metro | PASS | The managed Expo workflow reached its “Using Expo Go” state. |
| Public preview host reachable | PASS | The recorded public `GET /manifest.json` probe returned HTTP 200 with `text/html`. |
| Fresh preview opened in stock Expo Go on Android | **BLOCKED** | No physical phone, device farm, self-hosted Android runner, or Expo Go request was available. |
| Phone model, Android version, and Expo Go version captured | **BLOCKED** | There was no phone from which to read the requested metadata. |
| Expo Go session launch observed at Metro | **BLOCKED** | The available request was a workspace `curl` with `platform=-`, not a native Android client. |
| Redacted screenshot or exact phone error captured | **BLOCKED** | No phone screen or phone error was available. |

## Public reachability is not Expo Go launch

The public edge was checked independently of a phone:

```text
GET https://[development Expo host]/manifest.json
HTTP/2 200
content-type: text/html

[dev-request] 2026-09-14T14:43:29.681Z GET 200 4ms
host=[redacted] platform=- ua=curl/8.14.1 /manifest.json
```

`platform=-` and the `curl` user agent identify the workspace probe. They do
not show that stock Expo Go authenticated, fetched the project, or rendered it
on Android. No native-client request, phone screenshot, or phone error was
available, so the Expo Go launch result remains **BLOCKED**.

## Evidence completeness check

The repository check accepts this record as a valid **BLOCKED** record because
the missing physical-phone, native-request, and phone-screen boundaries are
explicitly identified. It does not accept the public `curl` response as an
Android preview pass. Run
`pnpm run validate:android-preview-evidence -- <path>/validation-record.md`
when filing a future record.

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

## Automated companion checks

These workspace checks passed for the same revision, but none replaces the
physical Expo Go launch:

1. Chat App CryptoContext, Room, and secure-storage tests: **3 suites, 56
   tests passed**. Jest printed an existing React `act(...)` warning from
   `VirtualizedList`.
2. API room socket suite: **1 file, 15 tests passed**.
3. API assistant, security, and profile suites: **3 files, 25 tests passed**.

## Next handoff

Use the manual phone, device-farm, or self-hosted-runner route in the
acceptance document. Keep this record as the blocked baseline and append a new
UTC directory after a real stock Expo Go session supplies the phone metadata,
native request evidence, and redacted launch result.
