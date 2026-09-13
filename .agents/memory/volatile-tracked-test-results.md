---
name: Volatile tracked test results
description: A tracked Playwright run marker under artifacts/api-server can change or vanish during unrelated work; check git status before completing a task.
---

`artifacts/api-server/test-results/.last-run.json` is committed to Git but is a Playwright run artifact, so it can show up as deleted or modified in `git status` even when the task never touched the API server (observed 2026-09-10 while only editing `lib/api-spec` scripts).

**Why:** run markers are rewritten or removed by test tooling, so an unrelated diff can otherwise ride along into a task's merge commit.

**How to apply:** before marking a task complete, review `git status` and restore any unrelated change to this file with `git checkout -- <path>` instead of committing it.

Automatic checkpoints can commit whole Playwright trace trees (`test-results/.playwright-artifacts-*/`) while an E2E run is in flight, and other tasks' checkpoints change which files main tracks. So after a rebase, align the directory to the *current* main (`git rm -r --cached` the dir, delete it, `git checkout main-repl/main -- <dir>`) rather than to the task's original base; the goal is zero test-results churn in the task's merge, not a specific historical snapshot.
