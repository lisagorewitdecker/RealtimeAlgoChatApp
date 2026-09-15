---
name: Release summary secret contract
description: Which release values may appear in GitHub step summaries and how the contract test protects credentials and private identifiers.
---

Rule: EAS candidate build IDs are non-secret configuration and may appear literally in release summaries. App IDs and smoke-account values remain private; credentials may only be exported by name to native tooling, never value-expanded into summaries.

**Why:** Reviewers need the real EAS candidate ID, and GitHub masks values supplied as secrets. EAS build IDs are not credentials, so they are variables or workflow inputs. App IDs and smoke-account values are still private and must not depend on summary masking.

**How to apply:** the contract test in `scripts/tests` inventories every summary writer and rejects credential or private-ID expansion. Candidate build IDs must originate from `vars.*` or reusable-workflow inputs, never `secrets.*`; summaries may render them and their fingerprints. Never `cat` arbitrary evidence or metadata into a summary—render only explicitly approved fields and link the detailed report. Prefer denylist-style assertions over snapshots because several tasks extend the same summary step concurrently.
