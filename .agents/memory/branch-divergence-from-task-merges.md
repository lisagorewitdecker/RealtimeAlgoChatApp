---
name: Task merges land on the checked-out branch
description: Reconciling task merges when branches diverge, and recognizing whole-file duplication inherited from the target branch.
---

Task merges are committed onto whichever branch is checked out in the workspace at merge time. A task branch can therefore contain a stale snapshot or unrelated tree changes even when the merge itself reports success.

**Why:** Replaying a task from an old or unrelated merge-base can duplicate blocks, overwrite newer manifests and workflows, and carry generated artifacts into the target branch. Treating the squash commit as authoritative preserves that drift.

**How to apply:** Compare the task tip and target by tree, not history. Keep only changes attributable to the task, restore unrelated files from the target, and drop generated test output. Consolidate in an external worktree while merges continue, then reunify stale branches with an ours merge so later rebases have a current merge-base. Verify the merge-base before relying on remote refs, and protect chained commands from falling through after a failed `cd`.

**Whole-file duplication is the recurring failure mode.** A file's entire content can appear appended to itself, repeatedly (up to eight copies observed), from platform "Git commit prior to merge" auto-commits and from the target branch itself. Package manifests become two JSON documents; shell scripts re-run their whole validation and then exit 2 on "syntax error: unexpected end of file"; ESM files fail with duplicate imports. Unreferenced "(copy)" files carrying raw conflict markers ride along the same way. A rebase onto such a target makes it worse: hunks replay into *both* copies and can erase the boundary between them.

**Two concatenation shapes, test both:** copies are sometimes joined mid-line (parent minus its trailing newline, then parent, e.g. `fi#!/usr/bin/env bash`) and sometimes plain (parent repeated verbatim, boundary on its own line). Testing only the mid-line shape reports "not a duplicate" for the plain kind. Compare the byte length against the parent's and check for an integer ratio first, then test n copies of both shapes.

**Detection:** duplicated shell source still passes `bash -n` while duplicated JSON does not, so manifests fail loudly and checkers fail silently. A clean `git status` proves nothing — the doubling can already be committed at HEAD. Walk the file's own history and parse each revision to find the last good one, and check every file the suspect commit touched: a later commit may restore some and leave others.

**How to pick the surviving copy:** when copies differ, the first is the newest — it carries the latest commit's additions while later copies predate them. Reconstruct from the first copy, diff it against the last known-clean revision, and confirm the only difference is that commit's intended change. Keep the copy that carries both the target's newer content and the task's own change, rebuilding a glued boundary line by hand. A fixed file can be doubled again by a later commit, so re-check after every rebase.

**When validation fails for a reason unrelated to the change,** validate the files it loads rather than re-reading the diff: `node --check` / `bash -n` per script and a JSON/YAML parse per manifest across the tree names the corrupt file in seconds.

**Completion validation after a mid-task rebase:** marking a task complete rebases onto the current target first, and nothing runs post-merge setup for the task environment afterwards. When every configured check fails at once though the task's own suite passed minutes earlier, do four things before reading individual failures: scan tracked files for appended copies; reinstall from the frozen lockfile (a merged dependency bump leaves `node_modules` behind and the Expo runtime check reports outdated packages); run the post-merge schema push (a merged schema change leaves the dev database behind and the API suite fails with "column ... does not exist"); and restart the API and Expo workflows so browser E2E checks hit current code and can sign in.
