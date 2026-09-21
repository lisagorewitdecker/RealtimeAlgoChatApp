---
name: Drizzle check constraint replacement
description: How to ensure changed PostgreSQL check expressions are applied by Drizzle schema push.
---

When changing the SQL expression of an existing Drizzle `check`, also change the constraint name so schema synchronization performs an explicit replacement.

**Why:** Drizzle schema push can report no changes when a check keeps the same name but its SQL expression changes, leaving the database on the old rule.

**How to apply:** Treat the constraint name as a versioned schema identity. After editing a check expression, rename it and verify the changed rule with a database-backed test.