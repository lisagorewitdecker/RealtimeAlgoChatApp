---
name: Open merges vs platform task merges
description: Why any in-progress merge in the main checkout must be done in a separate git worktree, and what GitHub web uploads drag into a merge.
---

Never leave a merge in progress in the main workspace checkout while project tasks are in MERGING state. Do cross-history merges (GitHub `main` into workspace `main`, remote pulls with conflicts) in a separate `git worktree` on a temporary branch, commit there, then fast-forward `main` in the main checkout.

**Why:** On 2026-09-15 a platform task merge landed while a nine-path conflict merge was half resolved in the main checkout. The merge reset the checkout `reset --hard`-style: `MERGE_HEAD`, the unmerged index entries, the working-tree resolutions, and the uploaded files were all gone, and `.replit` was left as an empty untracked file. The task's squash commit sat on top of the pre-merge tip as if the merge had never started. Work done in a worktree at `/tmp/...` was untouched by the same event.

**How to apply:**
- Create a backup branch at the current tip, `git worktree add /tmp/<name> -b <temp-branch> main`, merge there (never rebase — the join must keep both parents so GitHub accepts a normal push), run the pre-commit hook normally, then `git merge --ff-only <temp-branch>` in the main checkout (move any untracked empty `.replit` aside first). Remove the worktree and temp branches after the push.
- Expect GitHub-side "Add files via upload" commits to carry gitignored build outputs (`dist/*.d.ts`, `tsconfig.tsbuildinfo`), a stray one-byte `.githooks` file that collides with the hooks directory, a degraded `package.json` whose scripts silently skip checks, and an API client entrypoint without generated exports. Drop those in the merge; keep the workspace lockfile and prove `pnpm install --frozen-lockfile --offline` before committing.
- Restored validation workflows start immediately and hold the shared heavy-validation flock for a long time (Playwright downloads Chromium). Run light checks and the Chat App production build without the lock instead of queueing a script behind `flock -w 900`, which times out and reports spurious failures.
- Never `pkill -f` a pattern that appears in the ShellExec command line itself; it kills the calling shell and the tool reports exit -1 with no output.
---
name: Open merges vs platform task merges
description: Why any in-progress merge in the main checkout must be done in a separate git worktree, and what GitHub web uploads drag into a merge.
---

Never leave a merge in progress in the main workspace checkout while project tasks are in MERGING state. Do cross-history merges (GitHub `main` into workspace `main`, remote pulls with conflicts) in a separate `git worktree` on a temporary branch, commit there, then fast-forward `main` in the main checkout.

**Why:** On 2026-09-15 a platform task merge landed while a nine-path conflict merge was half resolved in the main checkout. The merge reset the checkout `reset --hard`-style: `MERGE_HEAD`, the unmerged index entries, the working-tree resolutions, and the uploaded files were all gone, and `.replit` was left as an empty untracked file. The task's squash commit sat on top of the pre-merge tip as if the merge had never started. Work done in a worktree at `/tmp/...` was untouched by the same event.

**How to apply:**
- Create a backup branch at the current tip, `git worktree add /tmp/<name> -b <temp-branch> main`, merge there (never rebase — the join must keep both parents so GitHub accepts a normal push), run the pre-commit hook normally, then `git merge --ff-only <temp-branch>` in the main checkout (move any untracked empty `.replit` aside first). Remove the worktree and temp branches after the push.
- Expect GitHub-side "Add files via upload" commits to carry gitignored build outputs (`dist/*.d.ts`, `tsconfig.tsbuildinfo`), a stray one-byte `.githooks` file that collides with the hooks directory, a degraded `package.json` whose scripts silently skip checks, and an API client entrypoint without generated exports. Drop those in the merge; keep the workspace lockfile and prove `pnpm install --frozen-lockfile --offline` before committing.
- Restored validation workflows start immediately and hold the shared heavy-validation flock for a long time (Playwright downloads Chromium). Run light checks and the Chat App production build without the lock instead of queueing a script behind `flock -w 900`, which times out and reports spurious failures.
- Never `pkill -f` a pattern that appears in the ShellExec command line itself; it kills the calling shell and the tool reports exit -1 with no output.
---
name: Open merges vs platform task merges
description: Why any in-progress merge in the main checkout must be done in a separate git worktree, and what GitHub web uploads drag into a merge.
---

Never leave a merge in progress in the main workspace checkout while project tasks are in MERGING state. Do cross-history merges (GitHub `main` into workspace `main`, remote pulls with conflicts) in a separate `git worktree` on a temporary branch, commit there, then fast-forward `main` in the main checkout.

**Why:** On 2026-09-15 a platform task merge landed while a nine-path conflict merge was half resolved in the main checkout. The merge reset the checkout `reset --hard`-style: `MERGE_HEAD`, the unmerged index entries, the working-tree resolutions, and the uploaded files were all gone, and `.replit` was left as an empty untracked file. The task's squash commit sat on top of the pre-merge tip as if the merge had never started. Work done in a worktree at `/tmp/...` was untouched by the same event.

**How to apply:**
- Create a backup branch at the current tip, `git worktree add /tmp/<name> -b <temp-branch> main`, merge there (never rebase — the join must keep both parents so GitHub accepts a normal push), run the pre-commit hook normally, then `git merge --ff-only <temp-branch>` in the main checkout (move any untracked empty `.replit` aside first). Remove the worktree and temp branches after the push.
- Expect GitHub-side "Add files via upload" commits to carry gitignored build outputs (`dist/*.d.ts`, `tsconfig.tsbuildinfo`), a stray one-byte `.githooks` file that collides with the hooks directory, a degraded `package.json` whose scripts silently skip checks, and an API client entrypoint without generated exports. Drop those in the merge; keep the workspace lockfile and prove `pnpm install --frozen-lockfile --offline` before committing.
- Restored validation workflows start immediately and hold the shared heavy-validation flock for a long time (Playwright downloads Chromium). Run light checks and the Chat App production build without the lock instead of queueing a script behind `flock -w 900`, which times out and reports spurious failures.
- Never `pkill -f` a pattern that appears in the ShellExec command line itself; it kills the calling shell and the tool reports exit -1 with no output.
---
name: Open merges vs platform task merges
description: Why any in-progress merge in the main checkout must be done in a separate git worktree, and what GitHub web uploads drag into a merge.
---

Never leave a merge in progress in the main workspace checkout while project tasks are in MERGING state. Do cross-history merges (GitHub `main` into workspace `main`, remote pulls with conflicts) in a separate `git worktree` on a temporary branch, commit there, then fast-forward `main` in the main checkout.

**Why:** On 2026-09-15 a platform task merge landed while a nine-path conflict merge was half resolved in the main checkout. The merge reset the checkout `reset --hard`-style: `MERGE_HEAD`, the unmerged index entries, the working-tree resolutions, and the uploaded files were all gone, and `.replit` was left as an empty untracked file. The task's squash commit sat on top of the pre-merge tip as if the merge had never started. Work done in a worktree at `/tmp/...` was untouched by the same event.

**How to apply:**
- Create a backup branch at the current tip, `git worktree add /tmp/<name> -b <temp-branch> main`, merge there (never rebase — the join must keep both parents so GitHub accepts a normal push), run the pre-commit hook normally, then `git merge --ff-only <temp-branch>` in the main checkout (move any untracked empty `.replit` aside first). Remove the worktree and temp branches after the push.
- Expect GitHub-side "Add files via upload" commits to carry gitignored build outputs (`dist/*.d.ts`, `tsconfig.tsbuildinfo`), a stray one-byte `.githooks` file that collides with the hooks directory, a degraded `package.json` whose scripts silently skip checks, and an API client entrypoint without generated exports. Drop those in the merge; keep the workspace lockfile and prove `pnpm install --frozen-lockfile --offline` before committing.
- Restored validation workflows start immediately and hold the shared heavy-validation flock for a long time (Playwright downloads Chromium). Run light checks and the Chat App production build without the lock instead of queueing a script behind `flock -w 900`, which times out and reports spurious failures.
- Never `pkill -f` a pattern that appears in the ShellExec command line itself; it kills the calling shell and the tool reports exit -1 with no output.
