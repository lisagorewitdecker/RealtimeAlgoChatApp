---
name: Task merge against an unrelated main lineage
description: What to do when a task-merge rebase starts replaying the branch from "Initial commit" because main-repl/main was force-updated to a history with no merge base.
---

Rule: if a task-merge rebase stops with "pick <sha> # Initial commit" and `git merge-base <task-branch> main-repl/main` is empty, do not resolve the conflicts. Abandon and retry the merge later.

**Why:** The merge fetch tracks the main Repl's *HEAD* (`+HEAD:refs/heads/main-repl/main`), not a fixed branch. A Git-pane operation in the main Repl (pull/branch switch mid-way, e.g. an auto "Git commit prior to merge" on a GitHub lineage) can be captured as a forced-update to a tree that shares no history with the task branch. Seen on 2026-09-13: the fetched HEAD was a 192-file GitHub snapshot (no lib/, no api-server sources, no scripts/tests) while the real project has ~1080 tracked files; the rebase queued all 15 branch commits with 21 config-file conflicts on the first pick. "Resolving" that would re-import the whole project onto a foreign branch rather than merge the task. Minutes later other tasks merged cleanly, confirming the state was transient.

**How to apply:** Check `git reflog show main-repl/main` (look for `forced-update`) and the merge base before touching any conflict. If `abandonMergeResolution` keeps returning `abort_failed` while the rebase is live, a plain `git rebase --abort` (verified first in a `.git` copy under /tmp) restores the branch and clean tree; calling `abandonMergeResolution` again afterwards succeeds and hands the task back with the recorded reason. Then ask the user to retry the merge; the task branch needs no changes.
