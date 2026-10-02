# Hosted native evidence summary check

**Result: PASS — the hosted `native-evidence-summary-regression` job succeeded
in a real GitHub Actions run, and the summary it generated contains separate
iOS and Android unavailable sections, each limited to its own missing-result
finding**

This record is tracked because the run's job summary is only visible to
signed-in GitHub users and the workflow's `test-results/` output is gitignored.
It records what the hosted run proved, where the evidence lives on GitHub, and
what was deliberately not exercised. No self-hosted iOS or Android runner was
used and no candidate was published: the workflow was dispatched with
`publish=false`, the native jobs were cancelled while still queued (no runner
ever claimed them), and the `always()` release gate failed by design because no
native evidence existed.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-15 14:51 to 15:06 |
| Workflow | `.github/workflows/mobile-release.yml` (`workflow_dispatch`, `publish=false`) |
| Files under test | `mobile-release.yml` (blob `43c829d`), `scripts/check-native-large-text-evidence.sh` (blob `5990015`), `scripts/run-untrusted-checker.sh` (blob `f88e1fd`) — byte-identical to workspace `main` at `c4ebd4b` |
| Verification branch | `task-407-hosted-summary-check`, commit `38dc85a` = GitHub `main` (`b865bf7`) plus only those three files; the full workspace history was not pushed |
| Primary run | [#34984445114](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34984445114) ("Mobile release accessibility gate #2"), created 14:51:14Z |
| Primary job | [Native evidence summary regression, job 104432827748](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34984445114/job/104432827748) — `success`, GitHub-hosted runner `GitHub Actions 1000020500` (`ubuntu-latest`, image `ubuntu-24.04`, runner 2.337.0), 14:51:18Z to 14:51:23Z |
| Summary-capture run | [#34986034990](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34986034990), job [104438245422](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34986034990/job/104438245422) — `success`, runner `GitHub Actions 1000020520`, 15:05:14Z to 15:05:21Z; branch `task-407-hosted-summary-echo` (commit `97eff10`, deleted after capture) |
| Native runners | None registered; `Native large-text smoke (iOS)`, `Android release runner preflight`, and `Native large-text smoke (Android)` ended `cancelled` with an empty runner name |
| Publish | `Publish tested mobile builds` ended `cancelled` without starting |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Hosted regression job runs on GitHub-hosted infrastructure without `needs`, before any native job | PASS | Job 104432827748 started 4 s after the run was created and finished in 5 s while every self-hosted job was still queued. |
| Blocked scenario: iOS section reports only the iOS missing result | PASS | The workflow's own `require_contains` / `require_not_contains` assertions passed on the hosted runner (step `Verify blocked native evidence summary` = `success`). The captured summary below shows the iOS section with exactly one finding, `Missing result directory: <root>/ios`. |
| Blocked scenario: Android section reports only the Android missing result | PASS | Same step; the Android section holds exactly one finding, `Missing result directory: <root>/android`, and no iOS path. |
| Both sections show `Status: FAIL`, `Validated run directory: Unavailable`, `Detailed evidence report: Unavailable` | PASS | Captured summary below; also asserted by the workflow step. |
| Failed platform artifact download scenario keeps the iOS download failure out of the Android section | PASS | Step `Verify failed platform artifact download summary` = `success`; the hosted log reports `[ios] The iOS native evidence artifact download did not complete`, one missing-directory finding per platform, and `FAILED with 3 issue(s)`. |
| Summary content is appended to the GitHub job summary | PASS (rendering not viewed) | Each verified step ends with `cat "$summary_path" >> "$GITHUB_STEP_SUMMARY"` after its assertions pass. GitHub hides job summaries from signed-out viewers (a signed-out browser render of the run page ends at "Annotations"), and neither the REST nor GraphQL check-run `output` carries step summaries, so the rendered block was not viewed from this workspace. Open the run while signed in to see it: <https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/34984445114#summary-104432827748>. |
| Hosted summary bytes reviewed | PASS | Run #34986034990 added one extra step after the two verified steps (which were unchanged) that re-ran the blocked scenario and echoed the resulting summary through `run-untrusted-checker.sh`. The text is reproduced below. |
| No native runner used, no candidate published | PASS | See Metadata: all self-hosted jobs cancelled while queued, publish never started, `publish=false`. |

## Hosted summary as generated by the checker (run #34986034990)

The `::stop-commands::` token is masked by GitHub, which confirms the wrapper
was active. Only the temporary root path differs between runs.

```markdown
## iOS native large-text evidence

- Status: **FAIL**
- Validated run directory: **Unavailable**
- Detailed evidence report: **Unavailable**

### Blocking evidence findings
- `Missing result directory: /tmp/tmp.18blzeAerv/ios. Run the ios native large-text gate and upload its timestamped result directory.`

## Android native large-text evidence

- Status: **FAIL**
- Validated run directory: **Unavailable**
- Detailed evidence report: **Unavailable**

### Blocking evidence findings
- `Missing result directory: /tmp/tmp.18blzeAerv/android. Run the android native large-text gate and upload its timestamped result directory.`
```

## Hosted log excerpt (run #34984445114, job 104432827748)

```text
Verify blocked native evidence summary
[ios] Missing result directory: /tmp/tmp.5bKXvXdhVv/ios. Run the ios native large-text gate and upload its timestamped result directory.
[android] Missing result directory: /tmp/tmp.5bKXvXdhVv/android. Run the android native large-text gate and upload its timestamped result directory.
Native large-text evidence completeness check FAILED with 2 issue(s).

Verify failed platform artifact download summary
[ios] The iOS native evidence artifact download did not complete. The downloaded iOS evidence is unavailable; rerun the release gate after the artifact is available.
[ios] Missing result directory: /tmp/tmp.0PSZhgEACC/ios. Run the ios native large-text gate and upload its timestamped result directory.
[android] Missing result directory: /tmp/tmp.0PSZhgEACC/android. Run the android native large-text gate and upload its timestamped result directory.
Native large-text evidence completeness check FAILED with 3 issue(s).
```

Both steps completed with `success`; the only annotation on the job is the
`actions/checkout@v4` Node.js 20 deprecation warning.

## Other jobs in the primary run

| Job | Conclusion | Note |
| --- | --- | --- |
| Idle profile registration | `failure` (exit 2) | Expected on the verification branch: it is based on GitHub `main`, which lacks the workspace's API server test scripts. Unrelated to the summary check. |
| Native large-text smoke (iOS) | `cancelled` | No runner with `self-hosted,macos,ios,smallest-simulator` exists. |
| Android release runner preflight | `cancelled` | No runner with `self-hosted,linux,android,smallest-simulator` exists. |
| Native large-text smoke (Android) | `cancelled` | Never started. |
| Mobile release gate | `failure` | `always()` gate ran after cancellation and failed because both native artifacts were missing — the fail-closed behaviour the gate is meant to have. |
| Publish tested mobile builds | `cancelled` | Never started; `publish=false`. |

## How the run was produced

The Replit GitHub connection cannot create or update workflow files (it lacks
the `workflow` OAuth scope), so the three files were pushed to the verification
branch with an owner-provided fine-grained token stored as the workspace secret
`GITHUB_WORKFLOW_PUSH_TOKEN`; the same token downloaded the job logs. The runs
were dispatched and cancelled through the GitHub connection. The token can be
revoked now that the evidence is captured.

Note: after the primary run completed, three web-UI suggestion commits landed on
`task-407-hosted-summary-check` (pull request #188). They were not part of any
run recorded here, and both files they touch fail to parse afterwards (the
workflow YAML at line 471 and the checker's `case` statement). Do not merge that
pull request; the workspace copies of these files are the source of truth.
