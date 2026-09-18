---
name: Task merges land on the checked-out branch
description: Durable guidance for reconciling task merges when branches diverge or rebase against the wrong checkout.
---

Task merges are committed onto whichever branch is checked out in the workspace at merge time. A task branch can therefore contain a stale snapshot or unrelated tree changes even when the merge itself reports success.

**Why:** Replaying a task from an old or unrelated merge-base can duplicate blocks, overwrite newer manifests and workflows, and carry generated artifacts into the target branch. Treating the squash commit as authoritative can preserve that drift.

**How to apply:** Compare the task tip and target by tree, not history. Keep only changes attributable to the task, restore unrelated files from the target, and drop generated test output. Consolidate in an external worktree while merges continue, then reunify stale branches with an ours merge so later rebases have a current merge-base. Before relying on remote refs, verify the merge-base and protect chained commands from falling through after a failed `cd`.

**Repeated copies, not just doubles:** the same corruption can append a file to itself many times (a checker was found at eight copies) and can recur in the working tree minutes later while unrelated merges continue. Copies are usually joined mid-line — the last line of one copy is concatenated with the first line of the next — so a shebang or brace count stays at one and hides the rest. Detect it generically: a corrupted file equals its own first copy with the trailing newline stripped, followed by that copy again. Duplicated shell source still passes `bash -n` and duplicated JSON does not, so the manifests fail loudly while checkers silently re-run their whole validation.

**How to pick the surviving copy:** when the copies differ, the first one is the newest — it carries the most recent commit's additions, and the later copies are the pre-change version. Reconstruct from the first copy, then diff it against the last known-clean revision and confirm the only difference is that commit's intended change before committing. If a clean commit is already at HEAD and the damage reappears unstaged, verify each file is an exact double of HEAD and `git checkout --` it rather than re-editing.

**Doubled files after a pre-merge auto-commit (2026-09-18):** a platform "Git commit prior to merge" captured four files whose whole content had been appended to itself; the hooks installer became a duplicate-import SyntaxError, so root `test:unit` failed inside an unrelated fixture chain while the task's own suites passed. When unrelated validation fails right after such a commit, `node --check` the scripts it touched, compare each file's halves against the parent commit, and restore from `<commit>^` with a deletion-only diff. Restart the Expo and API workflows as well: a task environment starts with neither running, so every proxied E2E check fails at sign-in.
