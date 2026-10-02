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

Real macOS and Windows launcher checks should be opt-in hosted-runner runs that
record through the validator's redacting capture path, then revalidate the
recorded file with the same parser. The Linux compatibility suite should remain
deterministic and fixture-based.

**Why:** Non-Linux launchers are not available in the development container,
while their output can contain user/workspace paths or credentials that must
not be uploaded as raw logs.

**How to apply:** Use the real-platform workflow after Expo or React Native
upgrades; compare loader identifiers and failure categories after redaction,
not private absolute paths.

Real-platform evidence must separate runner smoke/preflight failures from
launcher capture and validator revalidation results. A platform job that stops
before capture is not evidence that launcher wording changed.

**Why:** A hosted Windows smoke check can fail before the Expo launcher starts,
while another platform completes capture and revalidation successfully.

**How to apply:** Record each platform's capture and comparison status
independently; retain no raw runner output, and do not refresh samples or parser
patterns unless a redacted launcher capture actually shows new wording.
