---
name: Candidate-bound release evidence
description: Why mobile release gates for prebuilt binaries must inspect evidence carried by each candidate.
---

When a release workflow receives immutable iOS and Android build IDs, checking a secret in the release environment does not prove that the secret existed when those candidates were bundled. Require the native build lifecycle to stamp non-secret evidence into the binary, then inspect that evidence in the exact candidate being approved.

**Why:** Release-time configuration can be correct even when an older or separately built candidate silently omitted required build-time configuration.

**How to apply:** Put required configuration checks before native bundling, keep secret values out of logs and evidence, and make promotion depend on a marker or attestation extracted from each candidate binary.
