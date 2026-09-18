---
name: Task merges land on the checked-out branch
description: Durable guidance for reconciling task merges when branches diverge or rebase against the wrong checkout.
---

Task merges are committed onto whichever branch is checked out in the workspace at merge time. A task branch can therefore contain a stale snapshot or unrelated tree changes even when the merge itself reports success.

**Why:** Replaying a task from an old or unrelated merge-base can duplicate blocks, overwrite newer manifests and workflows, and carry generated artifacts into the target branch. Treating the squash commit as authoritative can preserve that drift.

**How to apply:** Compare the task tip and target by tree, not history. Keep only changes attributable to the task, restore unrelated files from the target, and drop generated test output. Consolidate in an external worktree while merges continue, then reunify stale branches with an ours merge so later rebases have a current merge-base. Before relying on remote refs, verify the merge-base and protect chained commands from falling through after a failed `cd`.

**Doubled files after a pre-merge auto-commit (2026-09-18):** a platform "Git commit prior to merge" captured four files whose whole content had been appended to itself; the hooks installer became a duplicate-import SyntaxError, so root `test:unit` failed inside an unrelated fixture chain while the task's own suites passed. When unrelated validation fails right after such a commit, `node --check` the scripts it touched, compare each file's halves against the parent commit, and restore from `<commit>^` with a deletion-only diff. Restart the Expo and API workflows as well: a task environment starts with neither running, so every proxied E2E check fails at sign-in.
