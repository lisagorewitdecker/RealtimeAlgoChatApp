---
name: Hook rollback replacement
description: Safety rule for restoring preserved Git hooks during setup or removal rollback.
---

Restore a preserved hook by renaming it directly over the active managed hook. Never remove the active hook first.

**Why:** If restoration fails after removing the managed hook, the repository has no active hook and one recovery copy may be harder to identify. Direct replacement either succeeds atomically or leaves both copies recoverable.

**How to apply:** Use this rule whenever dispatcher installation, uninstallation, or another hook-management operation restores a preserved developer hook. On failure, retain both paths and print exact manual recovery guidance.
