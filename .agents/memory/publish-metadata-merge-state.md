---
name: Publish metadata merge state
description: Release validation for dependency manifests and lockfiles after task merges.
---

After merging task work, do not treat a parseable dependency manifest or lockfile as resolved until the Git index has no unmerged entries.

**Why:** A working-tree file can contain valid resolved content while Git still retains conflict stages. Local installs may pass, but publishing or committing remains blocked or non-reproducible.

**How to apply:** Before publishing after a merge, verify there are no unmerged index entries, parse the relevant manifests, and run a frozen-lockfile install check.
