---
name: Preview evidence byte pairing
description: The relationship between preview preflight sidecars and Markdown handoff evidence
---

When a preview preflight sidecar is present, its public and local evidence strings must match the sibling Markdown Evidence cells exactly, including byte counts and producer wording for unavailable probes.

**Why:** Status-only matching lets a manually changed byte count retain a misleading PASS result, while generic fixture wording can hide whether the paired evidence contract is actually enforced.

**How to apply:** Preserve the validator’s redacted evidence strings in iOS and Android handoff fixtures; validate both status and evidence whenever the optional sidecar exists.