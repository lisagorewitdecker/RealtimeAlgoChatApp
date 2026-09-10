---
name: Physical-device evidence tasks
description: How to handle acceptance tasks that require real iPhones/Android phones when the workspace has no device access.
---

This workspace cannot reach a phone: no USB bus, no `adb`/`xcrun`/Maestro/Java, no EAS configuration or credentials, and no dedicated device test accounts. A task that requires physical-device evidence cannot be satisfied by anything run here.

**Why:** Two consecutive cycles re-probed the same environment and produced identical `BLOCKED` records; re-probing wastes the cycle, and substituting a simulator, emulator, Expo Go, or the web preview is explicitly disallowed by the acceptance plans.

**How to apply:** Probe once (tools, `/dev/bus/usb`, `artifacts/chat-app/.expo/devices.json`, `NATIVE_SMOKE_*` presence), write a timestamped `BLOCKED` record following the procedure doc in `artifacts/chat-app/docs/` (`encrypted-room-recovery-device-check.md` for the two-phone E2EE pass), run the automated companion suites at the current revision, then ask the user how they will provide device access (self-hosted runner, device farm, or a manual pass whose redacted evidence you file). Any candidate used for E2EE persistence evidence must be built from the revision that fixed native secure-store key names (2026-09-10) or later; earlier builds fail every persistence row for that known reason.
