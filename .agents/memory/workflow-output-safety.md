---
name: Workflow output safety
description: Reviewer-visible release output must encode workflow-command sentinels and guard untrusted subprocess logs.
---

Release checks have two separate output boundaries: summary files need control-character and `::` encoding, while subprocess logs need a stop-command guard. Use the shared sanitizer for values copied into summaries or diagnostics, and the cryptographically random wrapper around checkers that print artifact, runner, or external-service text.

**Why:** GitHub workflow commands are parsed from logs, and summary content can be altered by control-input sentinels even when the underlying check correctly fails.

**How to apply:** When adding a release workflow check or summary writer, inventory both its direct writes and invoked subprocess output; sanitize the former and wrap the latter, then add a sentinel regression.