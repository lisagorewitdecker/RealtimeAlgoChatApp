---
name: GitHub connection workflow scope and hosted-run verification
description: What the Replit GitHub connection cannot do for .github/workflows files, how to get a real Actions run for a workflow that only exists in the workspace, and how to read job summaries that GitHub hides.
---

The Replit GitHub connection lacks the `workflow` OAuth scope. It can dispatch and cancel runs, read run/job/check-run metadata, list branches, create or delete non-workflow refs, and comment on pull requests, but it cannot read or write `.github/workflows/*` contents (contents reads 403; ref updates whose commits touch a workflow 404; contents PUT to that path is blocked at the proxy). Job log downloads through the connection also fail (403 on the blob redirect).

**Why:** Workspace and GitHub histories of this repo diverge (GitHub `main` is far behind and lacks the release pipeline), and the repo is public with redactions that the workspace tree does not have. Pushing the whole workspace to prove a workflow would leak those files; only a minimal branch is safe.

**How to apply:**
- To run a workspace-only workflow on GitHub, ask the owner for a fine-grained token (Contents + Workflows write, Actions read) through the secrets flow, build a temporary branch from GitHub `main` plus only the files under test with git plumbing (temp index, no working-tree changes), push it with an inline credential helper that reads the secret, dispatch with `publish=false`, and cancel the run while self-hosted jobs are still queued (no runner ever claims them; the `always()` gate then fails by design). The same token downloads `/actions/jobs/{id}/logs`. Delete the branch afterwards and tell the owner to revoke the token.
- GitHub shows job summaries only to signed-in viewers, and neither REST nor GraphQL check-run `output` carries them, so a signed-out browser or the API cannot confirm the rendered block. To review the hosted bytes, run an extra step on the verification branch that repeats the scenario and echoes its summary through `scripts/run-untrusted-checker.sh` into the log; leave the verified steps unchanged.
- Re-check the temp branch head before reusing it: a pushed branch prompts the owner to open a pull request, and suggestion commits accepted there may not even parse. Verify only against the commit you built, and warn against merging the pull request.
- Only the owner can view the rendered summary; link them to `.../actions/runs/<run>#summary-<job>` and record the hosted evidence in a dated `artifacts/chat-app/docs/*-check-YYYYMMDD.md` record, matching the existing device-check records.
