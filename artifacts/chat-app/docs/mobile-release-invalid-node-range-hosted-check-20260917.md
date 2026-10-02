# Mobile release invalid Node range hosted check — 2026-09-17

**Result: PARTIAL — the recorded hosted Node range guard failed before release
work and prevented all downstream release jobs from starting; a fresh hosted
rerun is still required to capture the new API-readable annotation**

This record captures a temporary `workflow_dispatch` run against the hosted
repository. The run used the secret-free `node_range_override` fixture and
`publish=false`; no release credential was read or written and no self-hosted
runner was available to claim release work.

## Repeatable probe preflight

Run this preflight against the current hosted `main` branch and the published
`mobile-release.yml` workflow **before creating a verification ref**. Use the
already connected GitHub client for these requests. Do not request, copy,
print, or include a token in the probe output or the dated evidence record.
Record only the repository, branch, workflow, HTTP status classification, run
ID, job IDs, and public URLs.

The preflight is a capability check, not release evidence:

| Capability | Read-only or safe request | Required result |
| --- | --- | --- |
| Branch lookup | `GET /repos/<owner>/<repo>/branches/main` | `200`; the response's commit SHA is the baseline |
| Dispatch | `POST /repos/<owner>/<repo>/actions/workflows/mobile-release.yml/dispatches` with the baseline ref, `node_range_override=not-a-valid-node-range`, and `publish=false` | accepted; this known invalid range must fail in the Node guard before credential, native, or publish jobs can run |
| Run metadata | `GET /repos/<owner>/<repo>/actions/runs/<run_id>` | `200`; the uniquely correlated run belongs to the expected workflow, ref, and repository |
| Job metadata | `GET /repos/<owner>/<repo>/actions/runs/<run_id>/jobs` | `200`; job IDs and conclusions are available |
| Annotations | `GET /repos/<owner>/<repo>/check-runs/<check_run_id>/annotations` for the relevant jobs | `200`; annotation-only evidence is available |
| Raw job logs | `GET /repos/<owner>/<repo>/actions/jobs/<job_id>/logs`, following redirects | final `200` for log-capable access, or a classified `403`/`404` limitation; never record a signed redirect URL |

The dispatch request must use the known invalid range above and must never set
`publish=true`. That fixture is intentionally secret-free: the Node guard
fails before the credential preflight, native runners, browser release work, or
publish job can start. Workflow dispatch returns no run ID, so record the UTC
dispatch start time, the authenticated connection actor, the baseline commit
SHA, and the workflow/ref used. Poll workflow runs and accept exactly one
candidate matching all of those facts (workflow, `workflow_dispatch` event,
baseline ref and SHA, actor, and `created_at` at or after the recorded start).
Reject zero matches and reject multiple matches; never guess which concurrent
`main` dispatch is the probe. Then verify the run metadata, job graph, and
check-run annotations in that order.

For raw logs, treat the API's documented redirect as an intermediate response:
follow it and classify the final response status. A `403` or `404` from the
final raw-log request is a **missing log capability**, not a failed release
probe: report `raw job-log download: unavailable (Actions log scope)` and
select annotation-only evidence. If rendered step-summary bytes are required,
stop before creating the verification ref and use an owner-provided,
log-capable path instead. Do not retry by requesting or displaying
credentials, and do not write a signed redirect URL to the record.

Install the temporary-ref cleanup guard immediately before the first
create/push-ref operation. The guard must run on normal completion, dispatch
failure, metadata or annotation failure, log-capability failure, interruption,
and any later setup error:

```text
cleanup_ref() {
  if temporary_ref_was_created; then
    delete refs/heads/<temporary-ref>
    verify GET /repos/<owner>/<repo>/git/ref/heads/<temporary-ref> returns 404
  fi
}
trap cleanup_ref EXIT INT TERM
```

Do not create the temporary ref until every preflight row has been classified.
If setup fails after the ref is created, run the cleanup guard before reporting
the failure; a cleanup failure is itself evidence that the probe did not finish
cleanly and must not be hidden by the original error.

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
| API-readable guard evidence identifies the configured field and offending range | PASS (local contract) | The [guard workflow annotation source](../../../.github/workflows/mobile-release.yml) emits a bounded, sanitized check annotation: `package.json engines.node: <offending range>`. |
| Updated hosted run captures the new API-readable annotation | BLOCKED | The recorded run predates this implementation. The connected GitHub identity could read existing checks but could not publish a temporary workflow commit: workflow-file writes returned `403 Forbidden` and the commit mutation was denied. No newer hosted run is claimed. |
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

The workflow's rejection step now also emits the same bounded, sanitized value
as an API-readable check annotation before writing the step summary:

```text
package.json engines.node: not-a-valid-node-range
```

The workflow source above is the implementation link for this evidence path.
The linked guard job remains the reviewer-visible target for the older hosted
run, which predates the custom annotation.

GitHub's connected API exposes the check-run annotation and job graph but
returns `403 Forbidden` for
the raw Actions job-log download, so this record does not claim to reproduce
the rendered step-summary bytes. The hosted failure and the exact offending
range are independently visible in the linked run and its setup-node
check-run annotation. A fresh hosted dispatch is required before the custom
`package.json engines.node` annotation can be independently confirmed through
the API.

## Cleanup

The temporary verification ref was deleted after the run and evidence URL were
recorded. The hosted repository's self-hosted runner list was empty during the
check, and no native or publish job reached a runner.
