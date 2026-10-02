# API generated-client pull-request event check

**Result: PASS — a pull-request description-only edit started a fresh hosted
workflow run and changed API compatibility from blocked to approved without
publishing the description contents.**

This record retains the hosted run and job links after the temporary probes were
cleaned up. Neither probe was merged.

## Repeatable probe

Run the repository probe when the hosted event behavior needs to be checked
again. It creates a stale generated-client commit and a deterministic breaking
OpenAPI operation-id change from `development`, opens a temporary pull request,
creates a second fixture commit for `synchronize`, closes and reopens the pull
request, then edits only its description for `edited`. Before the edit,
compatibility must fail. The edited description adds both required declarations,
and compatibility must succeed on the unchanged head commit. The evidence record
contains only run/job metadata and step conclusions:

```sh
GITHUB_TOKEN="$TOKEN" \
GITHUB_REPOSITORY="lisagorewitdecker/RealtimeAlgoChatApp" \
node scripts/probe-api-codegen-events.mjs \
  --output artifacts/chat-app/docs/api-codegen-event-probe-result.json
```

The command exits unsuccessfully unless the pull request is confirmed closed
without merging and a follow-up branch lookup confirms that the temporary branch
was deleted. Keep the token in the environment; do not pass it as a command-line
argument. Use `--help` for timeout and branch options.

## Metadata

| Field | Result |
| --- | --- |
| Latest check time (UTC) | 2026-09-19 02:37 to 02:40 |
| Workflow | `.github/workflows/api-codegen.yml` (`pull_request` to `development`) |
| Hosted baseline | `development` at `7732e844b0577b44e1233a1327f4fcba1d897b72` |
| Probe pull request | [#274](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/274), closed unmerged |
| Probe branch | `api-codegen-stale-client-probe-20260919023739-5874`, deleted after verification |
| Opened head | `630e9e9ca1e42892c1d182f79f5e5fd661710a2c` |
| Synchronize/reopened/edited head | `5625ef811d97ec20f77d34dcaf51f3559df29e00` |
| Changed files | `lib/api-client-react/src/generated/api.schemas.ts` and `lib/api-spec/openapi.yaml` |

## Acceptance result

| Event | Workflow run | Check-generated job | Required step | Compatibility step |
| --- | --- | --- | --- | --- |
| Opened control | [#35416216394](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416216394) | [job 105825299044](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416216394/job/105825299044) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **failure** |
| Synchronize after branch update | [#35416256288](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416256288) | [job 105825413589](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416256288/job/105825413589) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **failure** |
| Reopened after close | [#35416298370](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416298370) | [job 105825533697](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416298370/job/105825533697) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **failure** |
| Edited after description-only update | [#35416336527](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416336527) | [job 105825637937](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35416336527/job/105825637937) | `Verify generated API clients`: **failure** | `Check API contract compatibility`: **success** |

All four runs used the `API generated clients` workflow and completed with
overall conclusion `failure` because the required generated-client check
failed. The compatibility step still ran. The first three runs blocked the
breaking operation-id change. The edited run approved it from the newly supplied
pull-request declarations.

The reopened run completed at `2026-09-19 02:40:09 UTC`. The probe then changed
only the pull-request description; edited run `35416336527` was created at
`02:40:12 UTC`. Both runs used head
`5625ef811d97ec20f77d34dcaf51f3559df29e00`, proving no code update occurred
between the blocked and approved compatibility decisions. The retained JSON
shape was checked not to contain declaration markers, the edited marker, or
declaration values.

## Cleanup

- PR #274 was closed without merging.
- Branch `api-codegen-stale-client-probe-20260919023739-5874` was deleted.
- The probe confirmed both cleanup operations before returning success.
