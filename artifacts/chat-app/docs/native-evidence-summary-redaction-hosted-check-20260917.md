# Hosted native evidence summary redaction check

**Result: PASS — a real GitHub-hosted run kept hostile artifact metadata out of
the checker streams and reviewer-facing summary while preserving the wrapper
markers and fixed release-blocking context**

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-17 19:03:00 to 19:03:02 |
| Workflow | `.github/workflows/native-evidence-summary-regression.yml` (`workflow_dispatch`) |
| Reviewed base | GitHub `origin`, commit `c017a48767b31973773578d4917208ae1f08fddd` |
| Verification ref | `agent/hosted-native-evidence-redaction-clean-20260917`, temporary commit `e200721fcecbc4cb892fef8972648d4e3d8932ff` |
| Primary run | [#35262525050](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35262525050) |
| Primary job | [Verify hosted native evidence summary, job 105341527885](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35262525050/job/105341527885) — `success`, GitHub-hosted `ubuntu-24.04` runner |
| Captured log | `.agents/outputs/native-evidence-summary-hosted-clean-run-35262525050.log` (ignored local evidence copy) |
| Cleanup | Temporary verification ref deleted after the log was captured |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Hosted regression ran against the reviewed workflow and checker scripts | PASS | Run `#35262525050`, job `105341527885` |
| Hostile shell and Markdown probes stayed out of checker stdout | PASS | The hosted step captured stdout before printing it; the raw probe scan found no `attacker.example`, `github.example`, workflow error/warning markers, or shell-marker path |
| Hostile shell and Markdown probes stayed out of checker stderr | PASS | The hosted step captured stderr before printing it; the same raw probe scan passed |
| Hostile values stayed out of the generated summary | PASS | The hosted step scanned its temporary `GITHUB_STEP_SUMMARY` file before cleanup |
| Hostile metadata was not evaluated as shell | PASS | The hosted assertion confirmed the shell-marker file was not created |
| Workflow command guard remained visible and paired | PASS | Captured output shows `::stop-commands::***` and `::***::`; the hosted step also matched the unmasked UUID form before GitHub log rendering |
| Fixed release-blocking context remained visible | PASS | Captured stderr contains both fixed artifact-download failures, the completeness failure, and `Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts.` |

## Captured checker stdout

GitHub masks the random stop token in downloaded logs. The checker stdout
captured from the hostile-metadata scenario was:

```text
::stop-commands::***
Checking native large-text evidence under /tmp/tmp.HXu2Hfpl4B
::***::
```

## Captured checker stderr

```text
[ios] The iOS native evidence artifact download did not complete. The downloaded iOS evidence is unavailable; rerun the release gate after the artifact is available.
[android] The Android native evidence artifact download did not complete. The downloaded Android evidence is unavailable; rerun the release gate after the artifact is available.
[ios] Missing result directory: /tmp/tmp.HXu2Hfpl4B/ios. Run the ios native large-text gate and upload its timestamped result directory.
[android] Missing result directory: /tmp/tmp.HXu2Hfpl4B/android. Run the android native large-text gate and upload its timestamped result directory.
Native large-text evidence completeness check FAILED with 4 issue(s).
Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts.
```

The temporary step assembled the hostile inputs from encoded literals rather
than exposing them in the workflow `env:` block. This keeps the hosted log
itself auditable: the raw hostile values do not appear in the downloaded job
log, while the checker still received and rejected them.
