---
name: Secret-free Playwright contracts
description: Isolation requirements for browser evidence regression jobs that must run without hosted Clerk or database credentials
---

Secret-free Playwright evidence jobs must explicitly opt into the existing setup-project skip path, and production-only resource modules must not be imported at spec module initialization.

**Why:** Playwright still executes a configured global setup project even when a grep selects a local test. A top-level database import can therefore fail on a missing `DATABASE_URL` before the controlled browser failure creates any evidence.

**How to apply:** Set the diagnostic setup-skip capability and the feature-specific failure capability together in the CI job. Keep Clerk/database imports inside the production test after its prerequisite skip, and prove the controlled run with those credentials unset.