# API generated-client pull-request event check

**Result: PASS — stale generated clients failed the required verification step
after both a `synchronize` update and a `reopened` event.**

This record retains the hosted run and job links after the temporary probe was
cleaned up. The probe was never merged.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 17:12 to 17:15 |
| Workflow | `.github/workflows/api-codegen.yml` (`pull_request` to `development`) |
| Hosted baseline | `development` at `6c9c2c4ce4681fd3c4b4a12b0e8d240ecbb05829` |
| Probe pull request | [#191](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/191), closed unmerged |
| Probe branch | `task-449-stale-client-events-20260915`, deleted after verification |
| Initial probe commit | `9f3b25f019392e0c3de924572ed78a0648eff0c1` |
| Synchronize probe commit | `f0a431bce2e42af098b234baaf405ad940182732` |
| Changed file | `lib/api-client-react/src/generated/api.schemas.ts` only; an intentional probe marker made the generated client stale |

## Acceptance result

| Event | Workflow run | Check-generated job | Required step | Compatibility step |
| --- | --- | --- | --- | --- |
| Opened control | [#34999820612](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999820612) | [job 104485150129](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999820612/job/104485150129) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |
| Synchronize after branch update | [#34999927152](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999927152) | [job 104485501892](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34999927152/job/104485501892) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |
| Reopened after close | [#35000008662](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35000008662) | [job 104485776887](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35000008662/job/104485776887) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |

All three runs used the `API generated clients` workflow and completed with
overall conclusion `failure` because the required generated-client check
failed. The compatibility step still ran, confirming that the generated-client
failure boundary was not bypassed or silently skipped.

## Cleanup

- PR #191 was closed without merging.
- Branch `task-449-stale-client-events-20260915` was deleted.
- A follow-up branch lookup returned `404 Not Found`.