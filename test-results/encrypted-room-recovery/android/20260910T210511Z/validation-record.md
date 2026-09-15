# Encrypted-room recovery validation — Android

**Overall result:** BLOCKED — required physical-device validation could not run  
**Recorded at (UTC):** 2026-09-10T21:05:11Z  
**Source revision:** `aebcfc4`
**Project SDK:** Expo SDK 57.0.0  
**Backend target:** Replit development API; no production data was used.  
**Procedure:** `artifacts/chat-app/docs/encrypted-room-recovery-device-check.md`

## Device and runner metadata

| Item | Result |
| --- | --- |
| Same signed release build on both Android phones | BLOCKED — no signed release candidate is available to this workspace |
| Prepared Android runner | BLOCKED — `adb`, SDK tools, emulator, Java, and Maestro are missing |
| Android phone A and phone B model/OS | Not available |
| Dedicated account labels A/B/C | Not available to this runner |
| Device identifiers, screenshots, logs | None collected |

## Physical-device acceptance matrix

| Check | Result | Evidence / blocker |
| --- | --- | --- |
| Room creation and key registration before join | BLOCKED | No reachable Android devices or signed candidate |
| Envelope exchange and live/history/sandbox decryption | BLOCKED | No controlled two-device session |
| Ciphertext-only backend boundary | BLOCKED | No device-originated session to inspect |
| Force-close and network-loss recovery | BLOCKED | Keystore and device networking not exercised |
| No unintended room-key replacement | BLOCKED | No physical persistence session |
| Supported identity reset and fresh envelope | BLOCKED | No physical identity reset; no user-facing reset control |
| Non-participant envelope denial | BLOCKED | No physical access-boundary session |
| Encrypted-room assistant rejection | BLOCKED | No physical room session |

Automated companion coverage passed in `automated-regression.txt`, including
rejection of valid-Base64 values that are shorter or longer than the
secretbox key size. It does not substitute for Keystore validation.

## Resume requirements

Use the same current signed candidate on two representative Android phones
from a prepared runner, with a non-production backend and three dedicated
verified accounts. Record only non-sensitive build/device/OS/account labels
and append redacted evidence before changing the overall result from BLOCKED.