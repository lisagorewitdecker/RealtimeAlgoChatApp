---
name: Validation registration side effects
description: setValidationCommand can rewrite the Run button and add a "Project" wrapper workflow; diff .replit against HEAD after registering a check.
---

After registering a validation command, diff `.replit` against `HEAD` and keep only the new `isValidation = true` workflow.

**Why:** On 2026-09-19 `setValidationCommand` for a new E2E check also set `runButton = "Project"` and added a parallel `Project` workflow that ran only that check, so the Run button would have launched a browser test instead of the Expo app. The workspace convention (restored in an earlier commit) is `runButton = "artifacts/chat-app: expo"` with no `Project` wrapper.

**How to apply:** Write the corrected TOML to a temp file inside the workspace and apply it with `verifyAndReplaceDotReplit` (direct edits are refused); the tool consumes the temp file. Confirm with `git diff .replit` and one `startValidationRun` of the new command.
