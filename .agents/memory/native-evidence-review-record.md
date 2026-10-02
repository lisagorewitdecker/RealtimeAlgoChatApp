---
name: Native evidence review record
description: Why the native large-text evidence check treats a missing human review as a report but a rejected or inconsistent review as a failure.
---

The `review-record.txt` (reviewer, UTC review time, candidate build ID,
APPROVED/REJECTED) is validated by the evidence completeness check. A missing
record is only reported ("Review pending") by default; explicit strict mode
makes a missing approval fatal for store submission.

**Why:** The same check runs in the CI release gate immediately after the
automated platform jobs, before any person could have reviewed the
screenshots, and the docs tell reviewers to run it *before* reviewing. Making
absence fatal would break every automated gate run and the pre-review use.
Rejection, a build ID that does not match the run, an ordinary per-run review
that predates completion, a cross-platform record, or template placeholders are
all fatal because they are positive evidence of a wrong or reused decision.

**How to apply:** Keep strict mode confined to the publish path. Ordinary
per-run and candidate-scoped reviews must postdate the evidence. The publish
workflow may create a candidate-scoped approval only behind a trusted human
authorization boundary; query the run approval history for the actual approver
and bind the approved, tested, and submitted build IDs before submission. Never
write review records for runner diagnostics
(`runner-check.txt`, `ios-readiness.md`, preflight summaries).
