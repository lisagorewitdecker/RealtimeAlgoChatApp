---
name: Task merges land on the checked-out branch
description: Why branches diverge after task merges, how the platform rebases task branches, and how to consolidate a split safely.
---
Platform task merges are committed onto whichever branch is checked out in the
workspace at merge time. If the Git pane switches branches between merges (the
iOS app does this easily), approved work ends up split across branches even
though every merge succeeded.

**Why:** In one session, merges landed on `production`, then on a task's own
`subrepl-*` branch, then on a stale `main`, then on a local Dependabot tracking
branch — the last checkout removed every workflow from `.replit`, produced a
broken lockfile (two `@clerk/expo` specifiers) and failed post-merge setup.

**How the platform merges (observed):** it rebases the task's source branch
onto the current HEAD (`git rebase` semantics: everything since the merge-base
is replayed, conflicts auto-resolved) and then records one squash commit named
after the task. When the merge-base is old or unrelated, the replay duplicates
test blocks, regresses docs and drags generated Playwright traces along, so the
squash commit is not a clean per-task diff. When the target lacks a shared
history it falls back to a single commit holding the task-tip versions of the
files the task touched.

**How to apply:**
- Treat the task's *own* commits at the top of its `subrepl-*` branch (after the
  last replayed lineage commit) as the source of truth, not the squash commit on
  the wrong branch. Cherry-pick them onto the trunk (`-n`, then commit with the
  task title) and drop any `artifacts/api-server/test-results/` additions.
- Do the consolidation in a `git worktree` outside the workspace so HEAD stays
  put while merges keep landing; switch the workspace only once at the end.
- After consolidating, `git merge -s ours <stale-branch>` so in-flight task
  branches based on it get a recent merge-base and rebase cleanly; then
  `git branch -f` the other branches onto the trunk.
- Compare trees, not histories, to verify: every difference between the trunk
  and the stale branch must be explainable (missing task, duplicate block,
  replay regression, generated output).
- Reconcile the memory index after any split: topic files without index lines
  and index lines without files both happen.
- The GitHub connection status alone does not reveal that `origin` holds an
  unrelated history; check `git merge-base` before any pull/push from the pane.
- Guard `cd` in chained shell commands (`cd dir || exit 1`). The container
  restarts under memory pressure and wipes `/tmp`, so a chained command whose
  `cd` fails falls through into the workspace checkout.
