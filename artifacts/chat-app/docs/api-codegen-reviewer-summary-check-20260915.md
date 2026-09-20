# Generated-client reviewer-visible summary check

**Superseded by
[`api-codegen-reviewer-evidence-check-20260918.md`](./api-codegen-reviewer-evidence-check-20260918.md).**
The inconclusive part below was resolved by publishing the same evidence as its
own check run, which is readable without signing in. The step-summary rendering
recorded here remains unverifiable by design.

**Result: PARTIAL / INCONCLUSIVE — a real disposable pull request ran the
current generated-client checker on GitHub Actions, failed at the intended
stale-client boundary, and made the failed check available from the pull
request's Checks tab. The rendered step-summary body still needs one
signed-in reviewer inspection.**

The step-summary body is restricted to signed-in GitHub viewers. This
workspace's browser session was signed out, so GitHub rendered the failed check
and its annotations but intentionally hid the summary body. Bearer and basic
token requests also remained signed out. The REST API returns
`output.summary: null` for this check and the connection received
`403 Forbidden` when attempting the job-log endpoint. The summary contract is
verified from the exact checker revision used by the hosted run and its focused
test, while the hosted run proves that the current checker executes on the real
pull-request path. The hosted reviewer rendering remains unconfirmed.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 20:24 to 20:25 |
| Repository | `lisagorewitdecker/RealtimeAlgoChatApp` |
| Base branch | `development` at `6c9c2c4ce4681fd3c4b4a12b0e8d240ecbb05829` |
| Workflow | `.github/workflows/api-codegen.yml` (`pull_request` to `development`) |
| Probe pull request | [#194](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/194), closed unmerged |
| Probe branch | `task-474-generated-client-summary-20260915`, deleted after verification |
| Probe head | `12ef5f6dab0237ee52e2a7d13f259d82108dfe34` |
| Hosted run | [#35019409426](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35019409426) |
| Hosted check job | [Check generated API clients, job 104551058148](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35019409426/job/104551058148) |
| Reviewer-facing Checks page | [Direct check view](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/commit/12ef5f6dab0237ee52e2a7d13f259d82108dfe34/checks/104551058148) |
| Changed generated path | `lib/api-client-react/src/generated/api.schemas.ts` |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Real pull-request workflow runs against a controlled stale generated client | PASS | Run `#35019409426` completed with overall `failure`; the `Verify generated API clients` step failed and the compatibility step still completed successfully. |
| Failed check is available from the reviewer-facing Checks UI | PASS | The direct check view opens without log access and shows `Check generated API clients` as failed with its annotations. |
| Changed generated paths are included in the rendered reviewer-visible summary | INCONCLUSIVE | The hosted run used the current `check-generated.mjs`, and local tests confirm its report lists `lib/api-client-react/src/generated/api.schemas.ts`; the signed-in rendered summary was not available in this workspace. |
| Bounded report is included in the rendered reviewer-visible summary | INCONCLUSIVE | The same checker revision writes the bounded `formatDriftReport` output inside a fenced `diff` block, and the focused API-spec test passed all 29 tests; hosted rendering still needs reviewer confirmation. |
| Regeneration command is included in the rendered reviewer-visible summary | INCONCLUSIVE | The hosted checker revision contains the exact command and the focused summary test asserts it; hosted rendering still needs reviewer confirmation. |
| Opening the failed check requires privileged job-log access | PASS | The direct Checks page opens while signed out. The job-log endpoint returned `403 Forbidden`, and no job log was used to establish this access result. |

## Summary contract to inspect

The exact summary shape exercised by the hosted revision, and the three strings
that remain to be confirmed in GitHub's signed-in rendered view, are:

````markdown
## Generated API drift detected

Regenerate with `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.

```diff
<bounded generated-path report, including lib/api-client-react/src/generated/api.schemas.ts>
```
````

The inner fence is rendered with a dynamically selected Markdown fence when
the report contains backticks, so generated content cannot terminate the
reviewer-visible block early.

## Remaining validation

Open the [direct check view](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/commit/12ef5f6dab0237ee52e2a7d13f259d82108dfe34/checks/104551058148)
while signed in to GitHub and confirm that its summary contains:

1. `lib/api-client-react/src/generated/api.schemas.ts`
2. A bounded fenced `diff` report
3. `pnpm --filter @workspace/api-spec run codegen`

This is the only unconfirmed part of the task. The disposable pull request and
branch have already been cleaned up.

## Cleanup

- PR #194 was closed without merging.
- Branch `task-474-generated-client-summary-20260915` was deleted.
- The local API-spec test suite passed: 29 tests passed.
