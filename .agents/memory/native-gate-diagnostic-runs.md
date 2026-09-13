---
name: Native gate diagnostic runs
description: How device-size overrides for the native large-text release gate must be labeled and contained so troubleshooting output is never taken as release evidence.
---

Rule: any override that lets the native large-text gate run on a device other
than the smallest supported one marks the *entire* run diagnostic-only, even if
the correct device happens to be booted. Diagnostic-only runs are labeled in
every artifact (readiness report heading and run mode, runner metadata, pass/fail
record, console banner), default to a separate results tree outside the release
evidence directory, and the evidence completeness check rejects any pass record
whose `run_mode` is not `release-gate`. GitHub Actions runs refuse the override
outright with a blocking prerequisite instead of silently ignoring it.

**Why:** reviewers read the readiness report and pass/fail record as release
evidence; a "READY" report from a larger simulator is a false claim about the
smallest-device gate. Refusing (rather than ignoring) the override in CI
surfaces a misconfigured self-hosted runner instead of hiding it.

**How to apply:** when adding a new override (for example an Android emulator
size override) or a new evidence artifact, keep all three layers: mode labeling
in every report, separation from the evidence tree, and CI refusal. Keep the
gate script bash-3.2 compatible because the iOS runner is macOS.
