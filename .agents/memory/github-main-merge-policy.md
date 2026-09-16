---
name: Merging GitHub main into the workspace
description: How to judge GitHub-side commits (Copilot autofix PRs) when origin/main diverges from the workspace, and the worktree recipe that lets the merged tree be fully validated before main moves.
---

GitHub's `main` receives Copilot "fix the failing job" pull requests that the owner merges on GitHub, and no pull-request check there runs this repo's contract tests (`pnpm test:unit`), so those commits can be unusable: duplicate YAML keys in `.github/workflows/mobile-release.yml`, bash syntax errors in `scripts/check-native-large-text-evidence.sh` and its test, a second implementation pasted above the shebang of `scripts/verify-sentry-native-event.mjs`, a placeholder `allowBuilds` block ("set this to true or false") in `pnpm-workspace.yaml`, and secret-backed candidate build IDs that the workspace deliberately moved to non-secret inputs. They also re-implement work that local task merges already landed (single-line candidate build IDs, `run_mode=release-gate`).

**Why:** on 2026-09-16 every GitHub-side change to a conflicting file was either broken or a duplicate; only three small, verifiable additions were worth keeping (a `crypto.randomUUID()` message ID, a `writeStepSummary` env-fallback test that the workspace implementation already satisfied, a trailing newline).

**How to apply:**
- Before adopting GitHub's side of any conflicting file, run `bash -n`, `node --check`, and a unique-key YAML parse (`yaml` package with `uniqueKeys: true`) on `origin/main:<path>`; prefer the workspace version whenever a workspace contract test covers the file, and say in the merge message which GitHub edits were dropped and why.
- Do the merge in a worktree under `.local/` (gitignored; same filesystem as the pnpm store, so `pnpm install --frozen-lockfile --offline` completes in ~16 s via hardlinks — a `/tmp` worktree cannot be `git worktree move`d back across devices). `prepare` is a no-op there because `core.hooksPath=.githooks` is shared repo config.
- `pnpm test:unit` copies the gitignored `artifacts/api-server/test-results/.last-run.json` and fails on a fresh checkout; copy that file from the main checkout into the worktree (or fix the test) before judging results. A nested-Playwright timeout in `e2e/clerk-retry.test.ts` under load is a rerun, not a merge regression.
- Commit the merge in the worktree with hooks on, `git merge --ff-only` it into `main`, then push; delete the worktree and temp branch afterwards.
