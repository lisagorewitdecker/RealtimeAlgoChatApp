---
name: Hosted summary byte capture
description: How hosted regressions expose exact validated summary bytes without relying on signed-in job summaries
---

When reviewers need the exact bounded bytes produced by a hosted regression,
capture only the trusted revision metadata plus the checker-owned summary
after all assertions pass, then publish that file as the `output.summary` of a
dedicated GitHub check run on successful completion. Keep checker
stdout/stderr and negative-case output outside the capture.

**Why:** GitHub Actions job summaries are hidden from signed-out viewers and
are not returned by the job's own check-run output. A dedicated check run is
publicly readable through the Checks API and Checks tab while keeping
untrusted process output out of the review record.

**How to apply:** Include the reviewed ref and resolved checkout SHA in the
captured file, bind the check run's `head_sha` to the captured resolved SHA,
make publication conditional on the whole regression succeeding, and state
clearly when a historical hosted run predates the capture behavior.