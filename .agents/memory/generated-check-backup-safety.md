---
name: Generated-client check backup safety
description: Rules for the codegen drift checker's backup/restore cleanup and how to simulate filesystem failures in its tests.
---

Never delete the checker's temporary backup unless every restoration step succeeded. On any restoration failure, report each failed step separately and print the absolute backup path so the developer can recover by hand.

**Why:** Restoration runs after codegen has already overwritten the developer's generated files, so the backup is the only remaining copy of their local edits. Crashing mid-restore or deleting the backup would lose those edits silently.

**How to apply:** Keep restoration best-effort per path (attempt every remove/restore step even after one fails), keep cleanup failures distinct from codegen and drift failures, and always exit nonzero when any cleanup step fails. Use absolute paths in recovery messages because `pnpm --filter` runs the script with the package directory, not the workspace root, as cwd.

**Simulating filesystem failures in tests:** as a non-root user, a read-only file (0o444) inside a read-only directory (0o555) makes both `rmSync` and `cpSync` fail deterministically on Node 24, because unlinking and overwriting need directory or file write permission. Skip such tests when `process.getuid()` is 0, and reopen permissions before deleting the fixture or the cleanup itself fails.
