# Hosted iOS preview preflight redaction check

This records the disposable hosted pull-request verification for malformed and
schema-invalid iOS preview preflight sidecars. The probe used unique private
markers in both sidecars; the marker values and sidecar payloads are
intentionally not reproduced here.

## Hosted run

- Workflow: **Mobile release accessibility gate**
- Job: **iOS preview evidence**
- Run: [35528447277](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35528447277)
- Job details: [iOS preview evidence](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35528447277/job/106124638174)
- Probe pull request: disposable PR #349 (closed after evidence capture)

## Result

- The job failed at the iOS evidence validation step, as expected for the two
  intentionally invalid sidecars.
- The job summary contained the fixed diagnostic:
  `The iOS preview preflight JSON artifact does not satisfy the redacted schema.`
  once for each invalid sidecar.
- The surfaced checker failure contained the same fixed diagnostic twice in
  total, once for each invalid sidecar.
- The job-summary section was present in the downloaded hosted job evidence.
- Both unique sidecar markers were absent from the hosted job evidence.
- Raw sidecar fragments were absent from the hosted job evidence.

The disposable branch and pull request were deleted after the log and summary
checks completed. The hosted run remains available at the link above.