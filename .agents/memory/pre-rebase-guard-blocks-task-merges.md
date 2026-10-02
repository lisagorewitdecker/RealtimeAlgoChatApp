---
name: Local pre-rebase guard blocks platform task merges
description: Why a task merge can fail with "Rebase onto the main repl failed (UNKNOWN)" and no conflict files, and how to scope the local pre-rebase guard so it still protects against GitHub replays.
---

A local `pre-rebase` hook that refuses large replays will also refuse the
platform's task merge, which rebases the task branch onto the main Repl's HEAD
(`refs/heads/main-repl/main`). Exempt that target explicitly; keep the guard for
every other upstream.

**Why:** The hook exits non-zero before any merge work begins, so `git rebase`
exits 1 having produced no conflicted paths. The merge driver reports only
`Rebase onto the main repl failed (UNKNOWN)`, `continueMergeResolution` and
`abandonMergeResolution` return no conflict files, and the working tree looks
perfectly clean — so the failure reads like a platform outage and invites
pointless retries or a destructive branch reset. A long-lived task branch easily
exceeds a 25-commit replay threshold once unrelated lineage accumulates.

**How to apply:**
- Diagnose by the shape of the failure: repeated `UNKNOWN`, empty
  `conflictFiles`, clean `git status`, and no `rebase-merge`/`rebase-apply`
  directory. Then check `git config --get core.hooksPath` and run the
  `pre-rebase` hook manually with the target as `$1` before blaming the platform.
- Compare the resolved SHA of the hook's `$1` against
  `refs/heads/main-repl/main` and exit 0 on a match, rather than raising the
  commit threshold, which would silently disable the GitHub protection too.
- Verify all three paths after editing: the platform target is allowed, a large
  replay onto a GitHub remote is still refused, and the hook stays untracked
  (it is listed in `.git/info/exclude`).
- Uncommitted memory edits do not survive the merge round-trip; re-apply them
  after the rebase finishes.
