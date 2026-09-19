---
name: Hosted preview dependency diagnostics
description: The boundary contract for platform-specific preview evidence jobs that delegate to shared validators.
---

Platform evidence jobs should check shared validator dependencies before invoking a record checker. If a dependency is missing, emit a fixed actionable reason, fail the job, and do not expose evidence content or checker output.

**Why:** A missing delegated validator otherwise surfaces as a misleading schema or record failure, and platform-specific jobs can drift when only one job owns the dependency check.

**How to apply:** Keep the guard and fixed diagnostic symmetric across platform jobs. Contract tests should create a changed record, omit the dependency, assert the summary and stderr contain only the fixed message, and prove the checker stub was not invoked.