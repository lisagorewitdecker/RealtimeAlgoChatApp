# API generated-client pull-request event check

**Result: PASS — stale generated clients failed the required verification step
after `synchronize`, `reopened`, and `edited` pull-request events.**

This record retains the hosted run and job links after the temporary probes were
cleaned up. Neither probe was merged.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 17:12 to 17:15; edited-event check 20:47 to 20:50 |
| Workflow | `.github/workflows/api-codegen.yml` (`pull_request` to `development`) |
| Hosted baseline | `development` at `6c9c2c4ce4681fd3c4b4a12b0e8d240ecbb05829` |
| Earlier probe pull request | [#191](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/191), closed unmerged |
| Earlier probe branch | `task-449-stale-client-events-20260915`, deleted after verification |
| Earlier probe commits | Initial `9f3b25f019392e0c3de924572ed78a0648eff0c1`; synchronize `f0a431bce2e42af098b234baaf405ad940182732` |
| Edited-event probe pull request | [#195](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/195), closed unmerged |
| Edited-event probe branch | `task-475-stale-client-edited-20260915`, deleted after verification |
| Edited-event probe commit | `814bedf55cf2de6f84f0cb14c871a34ed1ad4cd7` |
| Changed file | `lib/api-client-react/src/generated/api.schemas.ts` only; each probe used an intentional marker to make the generated client stale |

## Acceptance result

| Event | Workflow run | Check-generated job | Required step | Compatibility step |
| --- | --- | --- | --- | --- |
| Opened control | [#34999820612](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999820612) | [job 104485150129](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999820612/job/104485150129) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |
| Synchronize after branch update | [#34999927152](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999927152) | [job 104485501892](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999927152/job/104485501892) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |
| Reopened after close | [#35000008662](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35000008662) | [job 104485776887](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35000008662/job/104485776887) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |
| Edited after description update | [#35021848609](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35021848609) | [job 104559198556](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35021848609/job/104559198556) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |

All four runs used the `API generated clients` workflow and completed with
overall conclusion `failure` because the required generated-client check
failed. The compatibility step still ran, confirming that the generated-client
failure boundary was not bypassed or silently skipped.

For the edited-event probe, the PR description update completed at
`2026-09-15 20:48:08 UTC`, and run `35021848609` was created at
`2026-09-15 20:48:10 UTC` for the same head commit
`814bedf55cf2de6f84f0cb14c871a34ed1ad4cd7`. The job completed at
`20:49:37 UTC`; its `Verify generated API clients` step failed while
`Check API contract compatibility` succeeded.

## Cleanup

- PR #191 was closed without merging.
- Branch `task-449-stale-client-events-20260915` was deleted.
- A follow-up branch lookup returned `404 Not Found`.
- PR #195 was closed without merging after the edited-event run was recorded.
- Branch `task-475-stale-client-edited-20260915` was deleted.
- A follow-up PR lookup confirmed `merged: false`, and a branch lookup returned
  `404 Not Found`.