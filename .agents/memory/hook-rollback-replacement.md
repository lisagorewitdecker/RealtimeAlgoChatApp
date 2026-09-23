---
name: Hook rollback replacement
description: Safety rule for restoring preserved Git hooks during setup or removal rollback.
---

Restore a preserved hook by renaming it directly over the active managed hook. Never remove the active hook first. Treat registration and temporary-file cleanup as best-effort steps whose errors are collected; they must not prevent hook restoration or replace the original setup error.

**Why:** If restoration fails after removing the managed hook, the repository has no active hook and one recovery copy may be harder to identify. Direct replacement either succeeds atomically or leaves both copies recoverable. A cleanup exception thrown first can also hide the setup failure and skip restoration entirely.

**How to apply:** Use this rule whenever dispatcher installation, uninstallation, or another hook-management operation restores a preserved developer hook. Attempt restoration even after cleanup errors; if a failed cleanup can leave a temporary path occupied, stage a prior registration on a distinct rollback path. On failure, keep the setup error primary, identify every surviving path, and print exact manual recovery commands.
