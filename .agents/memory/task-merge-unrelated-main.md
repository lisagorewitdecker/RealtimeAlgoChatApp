---
name: Task merge against an unrelated main lineage
description: What to do when a task-merge rebase starts replaying the branch from "Initial commit" because main-repl/main was force-updated to a history with no merge base.
---

Rule: if a task-merge rebase stops with "pick <sha> # Initial commit" and `git merge-base <task-branch> main-repl/main` is empty, do not resolve the conflicts. Abandon and retry the merge later.

**Why:** The merge fetch tracks the main Repl's *HEAD* (`+HEAD:refs/heads/main-repl/main`), not a fixed branch. A Git-pane operation in the main Repl (pull/branch switch mid-way, e.g. an auto "Git commit prior to merge" on a GitHub lineage) can be captured as a forced-update to a tree that shares no history with the task branch. Seen on 2026-09-13: the fetched HEAD was a 192-file GitHub snapshot (no lib/, no api-server sources, no scripts/tests) while the real project has ~1080 tracked files; the rebase queued all 15 branch commits with 21 config-file conflicts on the first pick. "Resolving" that would re-import the whole project onto a foreign branch rather than merge the task. Minutes later other tasks merged cleanly, confirming the state was transient.

**Related-history variant (2026-09-17):** the swap can also land on a *related* branch, e.g. `main-repl/main` force-updated from the workspace main tip to the tip of GitHub's `copilot/fix-code-scanning-alerts` (a merge of GitHub main into the Copilot branch). The merge base is then recent, but the first `pick` is a main commit you did not author (`git log main-repl/main..<task-branch>` lists it) because that task merge never reached GitHub. Same rule: abandon, do not resolve — continuing would squash your task plus a replay of someone else's work onto whichever branch the main checkout is on.

**How to apply:** Check `git reflog show main-repl/main` (look for `forced-update`), the merge base, and whether every queued `pick` is your own commit before touching any conflict. If `abandonMergeResolution` keeps returning `abort_failed` while the rebase is live, a plain `git rebase --abort` (verified first in a `.git` copy under /tmp) restores the branch and clean tree; calling `abandonMergeResolution` again afterwards succeeds and hands the task back with the recorded reason. Then ask the user to retry the merge; the task branch needs no changes.
