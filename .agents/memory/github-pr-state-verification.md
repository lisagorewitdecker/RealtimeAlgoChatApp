---
name: GitHub PR state verification
description: Reconcile task snapshots with live GitHub pull-request state before attempting lifecycle operations.
---

Always fetch the current pull request state, merge status, base/head SHAs, and source-branch existence before attempting a rebase, reopen, or branch update.

**Why:** A task snapshot can describe an open review even after GitHub has merged the PR and deleted its source branch. Reopening or rewriting that history is then impossible or unsafe, while a review record can still be added as a comment.

**How to apply:** Treat a merged PR as immutable history. Verify the merge commit’s checks and current branch protections, record any current-tip failures without bypassing them, and explain the state difference when completing the task.