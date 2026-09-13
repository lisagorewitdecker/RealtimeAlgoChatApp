---
name: Generated-check test controls
description: Isolation rule for environment-driven fault injection and fixture paths in production-capable check scripts.
---

Environment variables that trigger test-only signals, failures, or fixture workspace selection must remain inert unless the test subprocess also supplies an explicit opt-in capability. Keep workspace selection separate from fault injection so each test receives only the capability it needs.

**Why:** Environment variables can be inherited accidentally by local commands and CI jobs. A test variable alone must never interrupt a real check, fabricate a cleanup failure, or redirect filesystem reads and writes.

**How to apply:** Keep ordinary command lines free of opt-ins. Test helpers should add the fixture-workspace capability for isolated subprocesses and add fault injection only for cases that exercise faults. Regression tests should prove inherited variables are rejected or ignored without the matching opt-in.