---
name: Hosted checker fixture layout
description: Isolated hosted shell-checker fixtures must preserve the repository-relative directories expected by their root discovery and local imports.
---

Hosted regression fixtures that execute a copied shell checker must place it below the fixture's expected `scripts/` root and copy its validator's local import graph and package manifest. Setting an absolute checker path alone is not enough because the checker derives its root from `BASH_SOURCE`.

**Why:** A hosted-only fixture can pass path selection but fail before validation when a copied checker resolves its root one directory too high or its validator imports are absent; the resulting schema diagnostic hides the fixture-layout error.

**How to apply:** Mirror the minimal repository tree under the temporary fixture, run the real wrapper and checker against it, and assert the reviewer summary and checker arguments afterward.