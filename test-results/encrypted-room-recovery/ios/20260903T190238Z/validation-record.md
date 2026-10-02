# Encrypted-room recovery validation — iOS

**Overall result:** BLOCKED — required physical-device validation could not run  
**Recorded at (UTC):** 2026-09-03T19:02:38Z  
**Source revision used for automated checks:** c3abfdbb1f0db194c38eef4df027f00f08660955  
**Backend target:** Replit development API (`REPLIT_DEV_DOMAIN`); no production data was used.

## Release and device metadata

| Item | Result |
| --- | --- |
| Exact installed release build ID | Not available |
| iOS phone model | Not available |
| iOS version | Not available |
| iOS device identifier | Not collected |
| App account A | Not available to this runner |
| App account B | Not available to this runner |
| Network profile | Not exercised |
| Screenshots or plaintext room content | None collected |

The workspace is Linux `x86_64`; it is not a prepared macOS runner. `xcrun`,
Maestro, and an installed release candidate were unavailable. No simulator was
substituted for a physical phone.

## Physical-device acceptance matrix

| Check | Result | Evidence / blocker |
| --- | --- | --- |
| Phone A creates encrypted room | BLOCKED | No reachable iOS device or installed release build |
| Phone B registers its public key before joining | BLOCKED | No reachable iOS device or installed release build |
| Key envelope exchange and usable decryption | BLOCKED | No two-device session |
| Live/history message and sandbox-state decryption | BLOCKED | No two-device session; no plaintext recorded |
| Force-close/reopen restores the persisted key | BLOCKED | SecureStore/Keychain behavior not exercised |
| Temporary network loss and registration retry | BLOCKED | No device/network exercise |
| No unintended replacement room key | BLOCKED | No device/network exercise |
| Identity reset/re-registration and fresh envelope | BLOCKED | No physical identity reset exercise |
| Non-participant cannot obtain a usable envelope | BLOCKED | No physical access-boundary exercise |
| Encrypted-room assistant remains unavailable | BLOCKED | No physical UI/session exercise |

## Identity-rotation limitation

The app currently has no documented user-facing device-key reset control in the
room flow. The authenticated profile API accepts a newly registered public key,
and automated coverage verifies that overwrite behavior, but this validation did
not edit SecureStore/Keychain or claim a physical identity-rotation pass.

## Resume requirements

Run the same release candidate on two representative physical iPhones from a
prepared macOS runner. Record only non-sensitive build/device/OS metadata, use
two dedicated verified accounts, and append redacted screenshots and logs under
this platform/timestamp convention. Complete the full matrix above before
changing this record from `BLOCKED`.
