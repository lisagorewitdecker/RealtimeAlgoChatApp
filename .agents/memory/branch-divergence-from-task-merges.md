---
name: Task merges land on the checked-out branch
description: Why branches diverge after task merges, how the platform rebases task branches, and how to consolidate a split safely.
---
Platform task merges are committed onto whichever branch is checked out in the
workspace at merge time. If the Git pane switches branches between merges (the
iOS app does this easily), approved work ends up split across branches even
though every merge succeeded. On 2026-09-13, a Git-pane switch from
`production` to a task branch and then through `development` to `main` split 32
approved merges across three workspace branches.

**Why:** A branch switch during the merge session placed otherwise successful
task merges on different tips. Rejoining the branches required comparing each
source tip's tree because the platform rebased task branches onto whichever
branch was checked out and the resulting squash diffs included rebase noise.

**How the platform merges (observed):** it rebases the task's source branch
onto the current HEAD (`git rebase` semantics: everything since the merge-base
is replayed, conflicts auto-resolved) and then records one squash commit named
after the task. When the merge-base is old or unrelated, the replay duplicates
test blocks, regresses docs and drags generated Playwright traces along, so the
squash commit is not a clean per-task diff. When the target lacks a shared
history it falls back to a single commit holding the task-tip versions of the
files the task touched.

**Task snapshots come back on merge.** A task environment is cloned from the
workspace checkout at the moment the task starts. If the wrong branch was
checked out then, the task's history shares no commit with the trunk and its
merge lands as the task's *whole tip tree*: every file that differs between the
stale snapshot and the trunk is overwritten (older manifests, tsconfig,
committed build output, memory notes), which broke the frozen install and the
publish build even though the task itself touched two files.

**A merge-join is rebase-hostile until it is pushed.** Joining the GitHub
history with `merge -s ours --allow-unrelated-histories` gives the platform's
task merges a merge-base again, but `git pull --quiet --no-edit --rebase origin
<branch>` (which ran automatically within seconds of the join) linearizes the
join: it tries to replay every workspace commit from the initial commit onto
the GitHub tip, stops on the first conflict, and leaves a detached HEAD whose
tree lacks the artifact manifests and workflows. Abort it (`git rebase
--abort`) and keep an untracked `.githooks/pre-rebase` guard (listed in
`.git/info/exclude`) that refuses rebases replaying more than ~25 commits until
the join has been pushed; a linear "import" commit instead of a merge would
break the task merge-bases, so it is not an alternative.

**How to apply:**
- After any merge from a task that started during a wrong checkout, diff the
  merge against its parent, keep only the files the task's own agent commits
  touched (verify their deltas match), and restore everything else from the
  pre-merge commit. Expect one such cleanup per affected task.
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
  `origin` now points to the real GitHub repository, not a stale backup mirror;
  fetch its live refs before relying on cached tracking refs.
- Guard `cd` in chained shell commands (`cd dir || exit 1`). The container
  restarts under memory pressure and wipes `/tmp`, so a chained command whose
  `cd` fails falls through into the workspace checkout.

**Git-pane Pull against a diverged GitHub branch:** it stops on conflicts and
leaves the workspace half-merged (conflict markers in `pnpm-lock.yaml`, files
deleted on GitHub staged for deletion), and every install or validation then
fails with "duplicated mapping key". `git merge --abort` first. Then merge the
GitHub head deliberately: keep the workspace lockfile (a GitHub-regenerated
lockfile follows GitHub's catalog) and keep `replit.md` (contract-guidance
tests read it). GitHub's branches share one tree, so merging the superset
branch and pointing the other local branches at the result makes every push a
fast-forward.
---
name: Task merges land on the checked-out branch
description: Why branches diverge after task merges, how the platform rebases task branches, and how to consolidate a split safely.
---
Platform task merges are committed onto whichever branch is checked out in the
workspace at merge time. If the Git pane switches branches between merges (the
iOS app does this easily), approved work ends up split across branches even
though every merge succeeded. On 2026-09-13, a Git-pane switch from
`production` to a task branch and then through `development` to `main` split 32
approved merges across three workspace branches.

**Why:** A branch switch during the merge session placed otherwise successful
task merges on different tips. Rejoining the branches required comparing each
source tip's tree because the platform rebased task branches onto whichever
branch was checked out and the resulting squash diffs included rebase noise.

**How the platform merges (observed):** it rebases the task's source branch
onto the current HEAD (`git rebase` semantics: everything since the merge-base
is replayed, conflicts auto-resolved) and then records one squash commit named
after the task. When the merge-base is old or unrelated, the replay duplicates
test blocks, regresses docs and drags generated Playwright traces along, so the
squash commit is not a clean per-task diff. When the target lacks a shared
history it falls back to a single commit holding the task-tip versions of the
files the task touched.

**Task snapshots come back on merge.** A task environment is cloned from the
workspace checkout at the moment the task starts. If the wrong branch was
checked out then, the task's history shares no commit with the trunk and its
merge lands as the task's *whole tip tree*: every file that differs between the
stale snapshot and the trunk is overwritten (older manifests, tsconfig,
committed build output, memory notes), which broke the frozen install and the
publish build even though the task itself touched two files.

**A merge-join is rebase-hostile until it is pushed.** Joining the GitHub
history with `merge -s ours --allow-unrelated-histories` gives the platform's
task merges a merge-base again, but `git pull --quiet --no-edit --rebase origin
<branch>` (which ran automatically within seconds of the join) linearizes the
join: it tries to replay every workspace commit from the initial commit onto
the GitHub tip, stops on the first conflict, and leaves a detached HEAD whose
tree lacks the artifact manifests and workflows. Abort it (`git rebase
--abort`) and keep an untracked `.githooks/pre-rebase` guard (listed in
`.git/info/exclude`) that refuses rebases replaying more than ~25 commits until
the join has been pushed; a linear "import" commit instead of a merge would
break the task merge-bases, so it is not an alternative.

**How to apply:**
- After any merge from a task that started during a wrong checkout, diff the
  merge against its parent, keep only the files the task's own agent commits
  touched (verify their deltas match), and restore everything else from the
  pre-merge commit. Expect one such cleanup per affected task.
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
  `origin` now points to the real GitHub repository, not a stale backup mirror;
  fetch its live refs before relying on cached tracking refs.
- Guard `cd` in chained shell commands (`cd dir || exit 1`). The container
  restarts under memory pressure and wipes `/tmp`, so a chained command whose
  `cd` fails falls through into the workspace checkout.

**Git-pane Pull against a diverged GitHub branch:** it stops on conflicts and
leaves the workspace half-merged (conflict markers in `pnpm-lock.yaml`, files
deleted on GitHub staged for deletion), and every install or validation then
fails with "duplicated mapping key". `git merge --abort` first. Then merge the
GitHub head deliberately: keep the workspace lockfile (a GitHub-regenerated
lockfile follows GitHub's catalog) and keep `replit.md` (contract-guidance
tests read it). GitHub's branches share one tree, so merging the superset
branch and pointing the other local branches at the result makes every push a
fast-forward.
