---
name: .replit merge regressions
description: Task merges can silently rewrite .replit; how to detect and restore lost validation commands and post-merge settings.
---

After any task merge that touched `.replit` (or left a conflict marker in it), diff the file against the last pre-merge revision (`git log -p -- .replit`) before declaring it fixed. A parse-clean file is not a complete file.

**Why:** On 2026-09-14 a task merge resolved a `.replit` conflict by keeping the task repl's older copy: it dropped all ten registered validation workflows (typecheck, unit tests, API/Chat App tests, the E2E suites) and reset `[postMerge] timeoutMs` from 180000 back to the 20000 default, while a later merge left a stray `>>>>>>>` marker plus a duplicate `[nix]` table that broke parsing. The parse error was visible; the lost content was not.

**How to apply:**
- Compare `grep -c 'isValidation = true' .replit` and the `[postMerge]` block across recent revisions; restore losses through the platform tooling (`setValidationCommand` per check, `setPostMergeConfig` for the timeout), never by pasting old TOML by hand.
- Verify with a strict parser (`python3 -c "import tomllib; tomllib.load(open('.replit','rb'))"`) and by running a cheap validation command through `startValidationRun`.
- `getValidationCommands()` may return an object without a `workflows` array; confirm registration from the strict parse or the workflow list instead.
- Some validation failures after a merge are unrelated to `.replit` (e.g. a file deleted by a separate commit); attribute each failure to its own commit with `git log --diff-filter=D` before touching anything.
- A task merge can concatenate a second JSON object onto a package manifest; validate changed package manifests before diagnosing artifact workflow startup.

**Why:** pnpm rejects concatenated JSON before the artifact starts, which can surface to users as a preview gateway failure.

**How to apply:** Parse each changed package manifest and compare its first object with the pre-merge revision; preserve the original object and remove only an appended duplicate.
- A Git-pane auto-commit can delete `.replit` outright (2026-09-15: commit "updated files" removed it along with the generated API client, which then broke the publish build). A pull of GitHub `main` afterwards leaves GitHub's copy or, after a platform task merge resets the checkout, an empty untracked `.replit`. Symptoms: every validation workflow vanishes and the platform reports post-merge `HOOK_NOT_FOUND: No post-merge script path configured in .replit`. Restore the last tracked copy (`git log --diff-filter=D -- .replit`, then `git show <commit>^:.replit`), strict-parse it, commit it; the platform re-registers the workflows within seconds and `runPostMergeSetup()` passes again.
- While `.replit` is untracked in the repository, every new isolated task environment starts with an untracked one-line stub (`modules = ["nodejs-24"]`), and the platform's task commit sweeps it in even when the task never touched configuration. Completion validation in that environment then runs with no registered workflows (run the project's tests directly), and once the workspace has its full file back the rebase stops on an add/add `.replit` conflict. Resolve it by taking the incoming side verbatim (`git show :2:.replit` to a temp file inside the workspace, then `verifyAndReplaceDotReplit`, then delete the temp file so it is not committed); the stub has nothing worth keeping. Expect shell `node` to vanish while the file holds conflict markers, and expect the rebase to discard uncommitted working-tree edits made after the task commit.

## Untracked stub in task environments

When the repository's tracked `.replit` has been deleted (on 2026-09-15 a workspace commit titled "updated files" removed the whole 204-line file), each new isolated task environment starts with an untracked one-line stub (`modules = ["nodejs-24"]`). The platform's task commit sweeps in every working-tree file, so a task that never touched configuration still merges that stub into the workspace, and the completion validation it reports as "passed" ran with no registered validation workflows.

**Why:** the stub looks harmless in `git status` (`?? .replit`) and is easy to ignore while working on unrelated files; the damage only appears after the merge.

**How to apply:** at task start, run `git ls-tree HEAD -- .replit`; if it prints nothing and `git status` shows `?? .replit`, say so to the user before completing, and run the project's tests directly instead of trusting completion validation. The last complete configuration is recoverable with `git log --all -- .replit` (the most recent full revision carried 11 `isValidation = true` workflows, the `Project` run button, deployment settings, and the extra Python module).
