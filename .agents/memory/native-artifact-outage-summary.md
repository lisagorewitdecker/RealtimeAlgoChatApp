---
name: Native artifact outage summary
description: Hosted release checks for continued artifact downloads and blocked native evidence summaries
---

For a GitHub Actions artifact-outage regression, inspect `steps.<id>.outcome`
for the real download result: a `continue-on-error` download can have a
successful step conclusion while its outcome is `failure`.

An outcome of `success` is not proof that a usable artifact was extracted:
strict validation must also find exactly one timestamped platform evidence
directory before approving promotion or publishing a report link.

**Why:** The hosted run proved continuation and blocking, but the runner's
per-step `GITHUB_STEP_SUMMARY` file boundary made a later step unable to read
the checker sections when the checker wrote directly to the job summary.

**How to apply:** Have the checker write to a private temporary summary file,
validate the platform sections there, then append that validated file to the
real `GITHUB_STEP_SUMMARY` only after the assertions pass.