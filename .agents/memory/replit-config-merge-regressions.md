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
- A Git-pane auto-commit can delete `.replit` outright (2026-09-15: commit "updated files" removed it along with the generated API client, which then broke the publish build). A pull of GitHub `main` afterwards leaves GitHub's copy or, after a platform task merge resets the checkout, an empty untracked `.replit`. Symptoms: every validation workflow vanishes and the platform reports post-merge `HOOK_NOT_FOUND: No post-merge script path configured in .replit`. Restore the last tracked copy (`git log --diff-filter=D -- .replit`, then `git show <commit>^:.replit`), strict-parse it, commit it; the platform re-registers the workflows within seconds and `runPostMergeSetup()` passes again.
