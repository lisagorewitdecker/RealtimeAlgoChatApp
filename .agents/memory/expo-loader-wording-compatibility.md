---
name: Expo loader wording compatibility
description: Keep preview startup diagnostics aligned with the Expo and React Native tooling that produced captured loader output.
---

Preview loader samples should record the installed Expo CLI and React Native versions, and validation should fail with maintenance guidance when a loader-like line is not recognized.

**Why:** Expo and its React Native DevTools launcher can change platform-specific failure wording; without a version-pinned compatibility check, handoff reviewers may receive only a generic Metro startup failure.

**How to apply:** When upgrading Expo or React Native, refresh the captured Linux, dyld, and Windows samples and update the loader parser in the same change before relying on preview handoff diagnostics.

The version guard belongs in the normal preview-startup validation entry point, not only in the broader Chat App test suite.

**Why:** A dependency upgrade can otherwise pass the preview validation workflow while leaving its captured loader evidence stale.

**How to apply:** Keep the compatibility check ahead of live preview startup so version or wording drift fails closed before a preview is handed off.