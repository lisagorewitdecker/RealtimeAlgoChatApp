# Mobile release invalid Node range hosted check — 2026-09-17

**Result: PASS — the hosted Node range guard failed before release work and
prevented all downstream release jobs from starting**

This record captures a temporary `workflow_dispatch` run against the hosted
repository. The run used the secret-free `node_range_override` fixture and
`publish=false`; no release credential was read or written and no self-hosted
runner was available to claim release work.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-17 22:28:03–22:28:13 |
| Workflow | `.github/workflows/mobile-release.yml` (`workflow_dispatch`) |
| Hosted repository revision | `91ee41cc9bc0ce2fbf33a2b115185758004ba479` |
| Verification ref | `validation/task-568-invalid-node-range-20260917` |
| Input | `node_range_override=not-a-valid-node-range` |
| Publish input | `false` |
| `package.json` engines.node | `>=24.0.0 <25.0.0` |
| Primary run | [#35282160003](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35282160003) |
| Guard job | [Validate mobile release Node range](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35282160003/job/105406330915) |
| Cleanup | Temporary verification ref deleted after the run was inspected |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Hosted workflow dispatch accepted the invalid-range fixture | PASS | Run `#35282160003`, event `workflow_dispatch`, `publish=false` |
| Node range guard ran before release checks | PASS | Guard job completed checkout and range read, then failed in `Reject invalid Node range before release checks` |
| Offending range was rejected | PASS | GitHub check-run annotation: `Unable to find Node version 'not-a-valid-node-range' for platform linux and architecture x64.` |
| Guard reported a failed release-blocking check | PASS | Guard job conclusion `failure`; the setup-node resolution step failed and the rejection step failed |
| iOS/Android preview evidence jobs started | PASS | `iOS preview evidence` and `Android preview evidence` both concluded `skipped` with no steps |
| Browser/idle-profile release work started | PASS | `Idle profile registration` concluded `skipped` with no steps |
| Native release work started | PASS | `Native large-text smoke (iOS)`, `Android release runner preflight`, `Native evidence summary regression`, and `Native large-text smoke (Android)` all concluded `skipped` with no steps |
| Release gate started | PASS | `Mobile release gate` concluded `skipped` with no steps |
| Publish work started | PASS | `Publish tested mobile builds` concluded `skipped` with no steps |

## Hosted job evidence

```text
Run: 35282160003
Run conclusion: failure
Guard job: Validate mobile release Node range — failure
Guard steps:
  Check out release candidate — success
  Read package.json Node range — success
  Resolve configured Node range — success
  Reject invalid Node range before release checks — failure

GitHub check-run annotation:
  Unable to find Node version 'not-a-valid-node-range' for platform linux and architecture x64.
```

The workflow's rejection step is the final guard step and emits the
`package.json engines.node` summary line before exiting. GitHub's connected API
exposes the check-run annotation and job graph but returns `403 Forbidden` for
the raw Actions job-log download, so this record does not claim to reproduce
the rendered step-summary bytes. The hosted failure and the exact offending
range are independently visible in the linked run and check-run annotation.

## Cleanup

The temporary verification ref was deleted after the run and evidence URL were
recorded. The hosted repository's self-hosted runner list was empty during the
check, and no native or publish job reached a runner.
