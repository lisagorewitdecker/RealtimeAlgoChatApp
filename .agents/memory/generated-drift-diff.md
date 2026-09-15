---
name: Generated drift diff rendering
description: Why the generated-client drift check renders its own bounded diff instead of shelling out to git or diff.
---

Keep the drift explanation in the dependency-free report module next to the checker, and keep its output bounded (per-file, total, and line-length caps).

**Why:** The checker's tests run against throwaway fixture workspaces outside any git repository and with a fake `pnpm` on PATH, so `git diff --no-index` or `/usr/bin/diff` would make the check depend on tools and repository state that are not guaranteed there. The diff is explanatory only: the exit code and byte-for-byte restoration are the contract, so rendering failures fall back to the plain path list rather than masking the drift.

**How to apply:** When extending the drift output, change the caps in the report module's defaults rather than adding unbounded printing, and keep the checker's restoration flow untouched (other work owns that area). The line-level diff falls back to a whole-block replacement past the edit-distance cap; that fallback is intentional, not a bug, since the output is truncated anyway.

When CI publishes drift to a check summary, embed the exact report already rendered for the job log in a fenced `diff` block; do not render a second variant.

**Why:** Reviewers need the same bounded evidence in the Checks tab, and one rendered string prevents the log and summary from disagreeing.

**How to apply:** Publish only when the CI summary environment variable is present so local runs retain their existing output and filesystem behavior.
