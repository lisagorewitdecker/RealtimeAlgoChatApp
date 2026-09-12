---
name: Generated-check fault controls
description: Isolation rule for environment-driven fault injection in production-capable check scripts.
---

Environment variables that trigger test-only signals or failures must remain inert unless the test subprocess also supplies an explicit opt-in capability.

**Why:** Environment variables can be inherited accidentally by local commands and CI jobs. A fault variable alone must never interrupt a real check or fabricate a cleanup failure.

**How to apply:** Keep ordinary command lines free of the opt-in. Test helpers should add it only for subprocess cases that intentionally exercise a fault, and regression tests should prove the same variables are ignored without that opt-in.