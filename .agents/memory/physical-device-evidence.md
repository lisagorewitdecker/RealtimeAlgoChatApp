---
name: Physical-device evidence tasks
description: How to handle acceptance tasks that require real iPhones/Android phones when the workspace has no device access.
---

This workspace cannot reach a phone: no USB bus, no `adb`/`xcrun`/Maestro/Java, no EAS configuration or credentials, and no dedicated device test accounts. A task that requires physical-device evidence cannot be satisfied by anything run here.

**Why:** Two consecutive cycles re-probed the same environment and produced identical `BLOCKED` records; re-probing wastes the cycle, and substituting a simulator, emulator, Expo Go, or the web preview is explicitly disallowed by the acceptance plans.

**How to apply:** Probe once (tools, `/dev/bus/usb`, `artifacts/chat-app/.expo/devices.json`, `NATIVE_SMOKE_*` presence), write a timestamped `BLOCKED` record following the procedure doc in `artifacts/chat-app/docs/` (`encrypted-room-recovery-device-check.md` for the two-phone E2EE pass), run the automated companion suites at the current revision, then ask the user how they will provide device access (self-hosted runner, device farm, or a manual pass whose redacted evidence you file). Any candidate used for E2EE persistence evidence must be built from the revision that fixed native secure-store key names (2026-09-10) or later; earlier builds fail every persistence row for that known reason.

## Release-pipeline tasks: audit GitHub, not just the workspace

Tasks that need a green `mobile-release` run (Sentry source-map proof, branding results, store submission) are blocked by GitHub-side state that the workspace cannot see from files. The GitHub connection's `proxyFetch` (admin on the repo) can read it without touching values: `/environments`, `/environments/<name>/secrets|variables`, `/actions/secrets|variables`, `/actions/runners`, `/actions/workflows/<file>/runs` return names, counts, and statuses only.

**Why:** On 2026-09-14 the audit showed none of the preconditions existed — no `mobile-release` environment, zero secrets/variables/runners/runs — and no EAS project at all (`eas.json`, bundle identifier, Android package, project ID missing), so re-probing phones or tokens locally would have missed the real blockers. Reading `.github/workflows/mobile-release.yml` contents through the API returned 403 (token scope); use the local git copy of `origin/development` instead.

**How to apply:** For any "confirm on the real release run" task, read the live GitHub state once, compare `origin/development` with the workspace (the pipeline files may be absent upstream), record names only in the BLOCKED record, and never create secrets or paste values. Creating the environment or non-secret variables is an owner decision — offer it, do not do it unasked.
