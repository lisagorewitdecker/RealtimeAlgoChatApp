# SDK 57 Android preview device check

**Result: BLOCKED — physical-device access was unavailable**

This record is tracked because the prescribed `test-results/` directory is
gitignored. It records what was verified from the workspace and what still
requires a real phone. No simulator or emulator was substituted.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-14 14:44:07 |
| App | Chat App |
| SDK/runtime | Expo SDK 57 (`expo` `~57.0.22`; `@expo/cli` `57.0.20`) |
| Client requested by the workflow | Stock Expo Go |
| Device model | N/A — no physical Android device attached |
| Android version | N/A — no physical Android device attached |
| Expo Go version | N/A — no Expo Go session available in this workspace |
| Build information | N/A — this is a development preview, not a published build |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| SDK 57 project preview starts | PASS | The managed Expo workflow reached Metro’s “Using Expo Go” state. |
| Public preview host is reachable | PASS | A public `GET /manifest.json` probe returned HTTP 200 with `text/html`. |
| Stock Expo Go 57 opens the preview on a physical Android phone | BLOCKED | No physical phone, USB bus, `adb`, or Expo device registry entry is available in this workspace. |
| Device model, Android version, and Expo Go version recorded | BLOCKED | There was no device from which to read the requested metadata. |
| Expo Go session launch observed | BLOCKED | No phone request reached Metro; only the workspace `curl` probe was logged. |
| Redacted screenshot or exact phone error captured | BLOCKED | No phone screen or phone error was available. |

## Public reachability versus Expo Go session launch

The public edge was reachable independently of a phone:

```text
GET https://[development Expo host]/manifest.json
HTTP/2 200
content-type: text/html

[dev-request] 2026-09-14T14:43:29.681Z GET 200 4ms
host=[redacted] platform=- ua=curl/8.14.1 /manifest.json
```

`platform=-` and the `curl` user agent identify this as the workspace probe,
not an Expo Go request. No native-client request was observed. This result
does **not** establish that Expo Go can authenticate or launch the project on a
physical Android phone. The previously reported private-account login message
was not independently reproduced because no physical device was available.

## Exact workspace blocking evidence

```text
adb: command not found
emulator: command not found
/dev/bus/usb: absent
artifacts/chat-app/.expo/devices.json: {"devices":[]}
native smoke environment variables: none present
```

The Expo workflow also emitted this non-fatal workspace warning:

```text
error while loading shared libraries: libgtk-3.so.0: cannot open shared object file: No such file or directory
```

Metro continued running after that warning and served the public probe. The
temporary `EXPO_DEV_REQUEST_LOG=1` setting used for this probe was removed
afterward rather than left as an always-on development setting.

## Automated companion suites

These checks passed at the same revision; they do not replace the physical
Expo Go launch:

1. Chat App CryptoContext, Room, and secure-storage tests: **3 suites, 56
   tests passed**. Jest printed an existing React `act(...)` warning from
   `VirtualizedList`.
2. API room socket suite: **1 file, 15 tests passed**.
3. API assistant, security, and profile suites: **3 files, 25 tests passed**.

## Required next evidence

Run the fresh preview from stock Expo Go 57 on a physical Android phone and
append a new tracked record with the phone model, Android version, Expo Go
version, and a redacted screenshot or exact phone error. A self-hosted runner,
device farm, or manual phone pass must provide the missing device boundary.