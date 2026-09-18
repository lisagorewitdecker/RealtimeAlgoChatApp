# Generated-client drift evidence: reviewer visibility check

**Result: PASS — a real pull request published the bounded generated-client
drift evidence as its own GitHub check run. The changed generated path, the
bounded report, and the regeneration command were read from a signed-out
browser on the pull request's Checks tab and from an unauthenticated
check-runs API request, with no job-log access.**

## Why the evidence moved out of the step summary

GitHub shows an Actions step summary only to signed-in viewers, and neither
REST nor GraphQL exposes it: the check run's `output.summary` stays `null`, and
`/actions/jobs/{id}/logs` returns `403` for this workspace's connection. The
restriction is platform-wide rather than repository-specific — a signed-out
load of an `actions/checkout` run shows the same "Sign in to view logs" state.
The workflow therefore publishes the same rendered evidence as a dedicated
check run, which GitHub serves through the public Checks UI and the public
check-runs API.

## Metadata

| Field | Result |
| --- | --- |
| Check date (UTC) | 2026-09-18 |
| Repository | `lisagorewitdecker/RealtimeAlgoChatApp` (public) |
| Base branch | `development` at `fa3cc64c4d1e01eb1424f0dd7aa9f363e2a9bab5` |
| Workflow | `.github/workflows/api-codegen.yml` (`pull_request` to `development`) |
| Probe pull request | [#264](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/264), closed unmerged |
| Probe branch | `task-474-check-run-evidence-20260918`, deleted after verification |
| Probe head | `8df4d1e1b8ceee1ec19e809c07e32b74135d147b` |
| Hosted run | [#35379915838](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35379915838) |
| Verification job | `Check generated API clients`, job `105713384851`, concluded `failure` |
| Published evidence check | `Generated client drift evidence`, check run `105713584242` |
| Changed generated path | `lib/api-client-react/src/generated/api.schemas.ts` |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| A real pull-request run exercises a controlled stale generated client | PASS | The probe branch added a stale block to `api.schemas.ts`; the `Verify generated API clients` step failed on exactly that drift. |
| The failed check is reachable from the reviewer-facing Checks UI | PASS | Both `Check generated API clients` and `Generated client drift evidence` appear on the pull request's Checks tab. |
| The changed generated paths are in the reviewer-visible summary | PASS | The rendered summary and the API response both contain `lib/api-client-react/src/generated/api.schemas.ts (modified: -6)`. |
| The bounded report is in the reviewer-visible summary | PASS | The summary contains the fenced `diff` block with the hunk header and the per-file and total line limits (`at most 200 lines per file and 1000 lines in total`). |
| The regeneration command is in the reviewer-visible summary | PASS | The summary contains ``Regenerate with `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.`` |
| No secret or privileged log access is required | PASS | The evidence was read twice without credentials: an unauthenticated `GET /repos/.../check-runs/105713584242` returned the full summary, and a signed-out browser rendered it on the Checks tab. Job logs were never downloaded; that endpoint still returns `403`. |

## Evidence read without any credentials

Unauthenticated API request (no `Authorization` header):

```text
GET https://api.github.com/repos/lisagorewitdecker/RealtimeAlgoChatApp/check-runs/105713584242
200 OK
name: Generated client drift evidence
conclusion: failure
output.title: Generated API drift detected
output.summary (762 characters):
```

````markdown
## Generated API drift detected

Regenerate with `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.

```diff
- lib/api-client-react/src/generated/api.schemas.ts (modified: -6)

Regeneration diff (a/ = current files, b/ = regenerated output; showing at most 200 lines per file and 1000 lines in total):

--- a/lib/api-client-react/src/generated/api.schemas.ts
+++ b/lib/api-client-react/src/generated/api.schemas.ts
@@ -142,9 +142,3 @@
 export type UnauthorizedResponse = {
   error: string;
 };
-
-// Intentionally stale generated content for the task 474 reviewer-evidence
-// probe. Regeneration removes this block, which is the drift under test.
-export type Task474StaleProbeMarker = {
-  reviewerEvidenceProbe: string;
-};
```
````

A signed-out Chromium session (fresh context, no stored credentials) loaded
`https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/264/checks?check_run_id=105713584242`
and rendered the same heading, regeneration command, changed path, and diff
block, while the page still offered "Sign in" and never exposed the job log.

The published check run and its summary remain readable after the probe pull
request was closed and its branch deleted.

## Cleanup

- Pull request #264 was closed without merging.
- Branch `task-474-check-run-evidence-20260918` was deleted.
- The temporary probe worktree and browser probe script were removed.
