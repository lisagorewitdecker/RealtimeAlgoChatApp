# Hosted native evidence summary revision check

**Result: PASS — a real GitHub Actions run verified that the blocked native
evidence summary preserves the reviewed ref and resolved commit SHA before
appending bounded iOS and Android sections; the workflow now publishes those
exact validated bytes in a public check run**

The listed hosted run predates the artifact capture change. The workflow's
hosted fixture now writes trusted revision metadata to the real
`GITHUB_STEP_SUMMARY` file, runs the checker through
`scripts/run-untrusted-checker.sh`, and only appends the checker summary after
the blocked scenario and platform-boundary assertions pass. It also captures
that exact bounded summary in the `Native evidence summary bytes` check run
after the assertions pass. The published output contains the reviewed ref,
resolved commit SHA, and validated iOS/Android sections only; checker
stdout/stderr and credentials are excluded.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-18 13:27:54 to 13:28:02 |
| Workflow | `.github/workflows/native-evidence-summary-regression.yml` (`workflow_dispatch`) |
| Reviewed ref input | `fa3cc64c4d1e01eb1424f0dd7aa9f363e2a9bab5` |
| Workflow checkout ref | `main` |
| Hosted run | [#35350360723](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35350360723) |
| Hosted job | Verify hosted native evidence summary, job `105616767808` |
| Runner | GitHub-hosted `ubuntu-latest` |
| Run result | `success` |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Hosted regression ran against the reviewed revision | PASS | Run `#35350360723` was dispatched with `reviewed_ref=fa3cc64c4d1e01eb1424f0dd7aa9f363e2a9bab5`; checkout and verification completed successfully. |
| Blocked-evidence checker took the intended nonzero path | PASS | The fixture only succeeds when `run-untrusted-checker.sh` returns nonzero for the missing iOS and Android evidence roots. The verification step completed successfully, so the unexpected-pass branch was not reached. |
| Checked ref and resolved commit SHA were preserved | PASS | The fixture wrote `Checked ref: \`fa3cc64c4d1e01eb1424f0dd7aa9f363e2a9bab5\`` and `Resolved commit SHA: \`fa3cc64c4d1e01eb1424f0dd7aa9f363e2a9bab5\`` before the checker could fail. |
| iOS section stayed bounded to iOS | PASS | Hosted assertions require FAIL/unavailable fields and exactly one iOS missing-result finding, while rejecting the Android path from the iOS section. |
| Android section stayed bounded to Android | PASS | Hosted assertions require FAIL/unavailable fields and exactly one Android missing-result finding, while rejecting the iOS path from the Android section. |
| Credentials and raw checker output stayed out of the summary sink | PASS | The checker runs with a separate temporary `GITHUB_STEP_SUMMARY`; its stdout is handled by the command-suppression wrapper, and only the validated summary file is appended to the real job summary. |
| Exact summary bytes are reviewable without signing in | PASS (workflow contract) | Each successful run publishes `Native evidence summary bytes` with the capture as `output.summary`, bound to the capture's resolved commit SHA. The listed 2026-09-18 run predates this check-run publication and is not represented as having one. |

## Summary rendering note

The run's job summary is hidden from signed-out GitHub viewers, while the
dedicated check run is the signed-out review path for the exact bytes. For
runs after this change, read `output.summary` from the public check-runs API or
open the check on the Checks tab:

<https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35350360723#summary-105616767808>

No native runner was used and no release or candidate was published.
