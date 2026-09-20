---
name: Hosted preview dependency diagnostics
description: The boundary contract for platform-specific preview evidence jobs that delegate to shared validators.
---

Platform evidence jobs should check shared validator dependencies before invoking a record checker. If a dependency is missing, emit a fixed actionable reason, fail the job, and do not expose evidence content or checker output.

**Why:** A missing delegated validator otherwise surfaces as a misleading schema or record failure, and platform-specific jobs can drift when only one job owns the dependency check.

**How to apply:** Keep the guard and fixed diagnostic symmetric across platform jobs. Contract tests should create a changed record, omit the dependency, assert the summary and stderr contain only the fixed message, and prove the checker stub was not invoked. When a test copies a validator into an isolated fixture, copy every same-directory import it needs, including versioned runtime-fixture modules.

## Validator import inventories (2026-09-20)

Three places enumerate the preview-startup validator's local module graph by hand and drift silently when it gains an import: the Android evidence shell test's isolated "default discovery" fixture (a `cp` list), the hosted preview-startup summary regression workflow's `pull_request.paths`, and that workflow's contract test. The Android shell test failure mode is an empty log with exit 1, because the checker discards the validator's stderr and `set -e` aborts inside the `$(...)` capture before any assertion message prints; run it under `bash -x` to see the "does not satisfy the redacted schema" verdict that really means ERR_MODULE_NOT_FOUND.

**How to apply:** whenever `validate-preview-startup.mjs` (or a module it imports) starts importing another sibling, grep for `preview-startup-shared.mjs` across `scripts/tests` and `.github/workflows` and add the new module beside it everywhere it appears.
