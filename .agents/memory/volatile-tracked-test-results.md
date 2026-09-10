---
name: Volatile tracked test results
description: A tracked Playwright run marker under artifacts/api-server can change or vanish during unrelated work; check git status before completing a task.
---

`artifacts/api-server/test-results/.last-run.json` is committed to Git but is a Playwright run artifact, so it can show up as deleted or modified in `git status` even when the task never touched the API server (observed 2026-09-10 while only editing `lib/api-spec` scripts).

**Why:** run markers are rewritten or removed by test tooling, so an unrelated diff can otherwise ride along into a task's merge commit.

**How to apply:** before marking a task complete, review `git status` and restore any unrelated change to this file with `git checkout -- <path>` instead of committing it.
