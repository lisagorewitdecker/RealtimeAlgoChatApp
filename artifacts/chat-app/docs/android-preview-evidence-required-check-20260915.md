# Hosted Android preview evidence required-check handoff

**Result: PASS — a disposable pull request proved that an invalid Android
preview evidence record fails the required check and that the corrected record
produces the exact required check context.**

The probe was never merged. It used a temporary branch against the live
repository default branch and was deleted after both hosted runs completed.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 18:05 to 18:07 |
| Repository | `lisagorewitdecker/RealtimeAlgoChatApp` |
| Base branch | `main` at `b865bf7de17641aa73e2d705e9bab7135fbb5038` |
| Workflow | `.github/workflows/mobile-release.yml` (`pull_request`) |
| Required ruleset | [Ruleset1](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/rules/21924513), active |
| Required status context | `Android preview evidence` |
| Probe pull request | [#192](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/192), closed unmerged |
| Probe branch | `task-453-android-evidence-20260915180454`, deleted after verification |

## Acceptance result

| Probe revision | Hosted run | Evidence job | Check result | PR merge state |
| --- | --- | --- | --- | --- |
| `a343f45851bfc87be641ec511591342d44dd51be` — intentionally invalid boundary status | [Run #35005288552](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35005288552) | [Job 104503402960](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35005288552/job/104503402960) | `Android preview evidence`: **failure** | `mergeable_state: unstable`; not merged |
| `cf07b00d537c0af51132014f8d9fe30f5cfa93a2` — valid Android preview record and sidecar | [Run #35005473927](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35005473927) | [Job 104504010450](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35005473927/job/104504010450) | `Android preview evidence`: **success** | PR remained unmerged pending cleanup |

The invalid revision demonstrated the required-check failure boundary. The
corrected revision demonstrated the exact `Android preview evidence` context
required by the active ruleset. The valid run used a `BLOCKED` handoff record
with all four required boundaries and the matching redacted JSON sidecar; it
did not claim a physical Android launch.

## Cleanup

- PR #192 was closed without merging.
- Branch `task-453-android-evidence-20260915180454` was deleted.
- A follow-up branch lookup returned `404 Not Found`.
- The local disposable worktree and branch were removed.
