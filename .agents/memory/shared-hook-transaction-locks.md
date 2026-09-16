---
name: Shared hook transaction locks
description: Safety rules for coordinating shared Git hook registration updates across processes.
---

Publish a fully owned lock by atomically renaming a prepared candidate into the canonical lock path. Release or reclaim it by atomically renaming the canonical path to a unique disposal path before recursive deletion. Preserve and restore the previous registration and repository-local records when setup fails.

**Why:** Creating ownership metadata after claiming the canonical path leaves an interruption window, and recursively deleting the canonical path creates a check/delete race where another process can publish a new lock under the same name. Failed reinstalls must not erase a registration that worked before the attempt.

**How to apply:** Use this protocol for every install or uninstall transaction that mutates a shared hooks directory. Validate owner identity before stale recovery, publish file replacements through temporary paths and atomic rename, and test contention with explicit process coordination rather than timing-only assertions.
