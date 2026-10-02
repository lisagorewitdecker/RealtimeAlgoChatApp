# Expo Go public preview device check — 2026-09-18

**Result: BLOCKED — the public preview and Metro handoff are healthy, but no
physical phone or simulator was available in this workspace to open the
preview.**

This check keeps public-edge reachability, the local Metro handoff, and the
physical Expo Go launch as separate boundaries. A successful manifest or bundle
request is not physical-device evidence.

## Environment and device metadata

| Field | Result |
| --- | --- |
| App | Chat App |
| Expo SDK | 57 (`expo` `~57.0.24`) |
| React Native | `0.86.3` |
| Target device model | **BLOCKED** — no phone or simulator attached |
| Target OS/version | **BLOCKED** — no phone or simulator attached |
| Stock Expo Go version | **BLOCKED** — no Expo Go session was available |
| Check timestamp | 2026-09-18 UTC |

The one-time availability probe found no `adb`, `xcrun`, `maestro`, or `java`,
no `/dev/bus/usb`, an empty `artifacts/chat-app/.expo/devices.json`, and no
`NATIVE_SMOKE_*` environment variables. No device values are inferred from
the QR code or workflow output.

## Handoff result

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public Android manifest reachability | **PASS** | HTTP 200; 2,801 bytes; manifest had `createdAt`, `runtimeVersion`, `launchAsset`, and a signed-in `extra.expoGo.username` |
| Local Android handoff probe | **PASS** | Manifest HTTP 200 (2,801 bytes); bundle HTTP 200 (16,135,073 bytes) |
| Expo Go launch on a physical device | **BLOCKED** | No phone or simulator was available; no model, OS, or Expo Go version can be recorded |
| Server-side native request evidence | **BLOCKED** | The redacted iOS launch probe reported `NO_DEVICE`; zero Expo Go inspector connections and zero request-log lines |

The local preview validator also recorded:

```text
dev_server_sign_in=SIGNED_IN
public_manifest_reachability=PASS
local_handoff_probe=PASS
expo_go_launch=NOT_ASSESSED
server_native_request_evidence=NOT_ASSESSED
```

The public edge initially returned HTTP 502 because the managed Expo workflow
could not parse a duplicated JSON object in `artifacts/chat-app/package.json`.
After removing only that duplicate object, the workflow reached
`Starting Metro Bundler`, the public manifest returned HTTP 200, and the full
preview-startup validator passed. This was a workflow/package startup failure,
not evidence of a device or public-edge failure.

The opt-in redacted launch probe then restarted the healthy workflow and
reported:

```text
preview_launch_evidence=NO_DEVICE
metro_ready=yes
expo_go_ios_connections=0
ios_bundle_http_200=0
expo_go_asset_requests=0
request_log_lines=0
```

## Follow-up needed for a complete device pass

Repeat this record from an available iOS or Android phone/simulator using stock
Expo Go. Record the actual model, OS/version, Expo Go version, landing-screen
result, and the filtered redacted native request marker. Do not change the
public or local PASS rows to represent that future physical session.
