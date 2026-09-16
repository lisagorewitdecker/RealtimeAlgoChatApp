---
name: Generated-check test controls
description: Isolation rule for environment-driven fault injection and fixture paths in production-capable check scripts.
---

Environment variables that trigger test-only signals, failures, or fixture workspace selection must remain inert unless the test subprocess also supplies an explicit opt-in capability. Keep workspace selection separate from fault injection so each test receives only the capability it needs.

**Why:** Environment variables can be inherited accidentally by local commands and CI jobs. A test variable alone must never interrupt a real check, fabricate a cleanup failure, or redirect filesystem reads and writes.

**How to apply:** Keep ordinary command lines free of opt-ins. Test helpers should add the fixture-workspace capability for isolated subprocesses and add fault injection only for cases that exercise faults. Regression tests should prove inherited variables are rejected or ignored without the matching opt-in. Harnesses that spawn subprocesses must strip the opt-in variables from their base environment instead of spreading `process.env` as-is; otherwise a value inherited by the harness itself pollutes every fixture, including the one meant to prove inertness. This rule also governs the Playwright Chromium runtime-contract fixtures, not only generated-client checks. Audit every `process.env.X ?? <default path>` in check scripts: a redirect variable that predates the rule (the Chromium checks' `.replit` path override) behaved like ordinary configuration, so a value left over from a harness that deleted its temp file crashed normal checks with a raw ENOENT. Fixture-path controls belong in the harness's stripped base-environment set together with their opt-in, and resolving them through one shared helper keeps sibling checks from drifting on the gating.

Temporary checkout fixtures should be built from tracked files rather than recursive copies, then link installed dependencies from the real checkout. This excludes ignored caches and avoids restrictive native binaries that can make cleanup fail.
