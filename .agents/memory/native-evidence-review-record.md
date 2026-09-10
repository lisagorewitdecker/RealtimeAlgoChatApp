---
name: Native evidence review record
description: Why the native large-text evidence check treats a missing human review as a report but a rejected or inconsistent review as a failure.
---

The per-run `review-record.txt` (reviewer, UTC review time, candidate build
ID, APPROVED/REJECTED) is validated by the evidence completeness check, but a
*missing* record is only reported ("Review pending"), never a failure.

**Why:** The same check runs in the CI release gate immediately after the
automated platform jobs, before any person could have reviewed the
screenshots, and the docs tell reviewers to run it *before* reviewing. Making
absence fatal would break every automated gate run and the pre-review use,
with no mechanism for CI to receive a record. Rejection, a build ID that does
not match the run, a review time earlier than the run's completion, a
cross-platform record, or template placeholders are all fatal because they are
positive evidence of a wrong or reused decision.

**How to apply:** If a future change must enforce approval before publishing,
add an explicit strict mode (flag or env) used only by the publish path rather
than changing the default, and carry the decision by candidate build ID, not
by run ID, because reruns produce new run directories for the same candidate.
Never write review records for runner diagnostics (`runner-check.txt`,
`ios-readiness.md`, preflight summaries).
