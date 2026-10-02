---
name: Reviewer-visible CI evidence
description: Why CI failure evidence belongs in a check-run summary rather than an Actions step summary, and how to prove it is readable.
---

Publish reviewer-facing CI evidence as its own GitHub **check run** (`POST
/repos/{owner}/{repo}/check-runs` with `output.title` and `output.summary`,
job permission `checks: write`), not only through `GITHUB_STEP_SUMMARY`.

**Why:** an Actions step summary is visible only to signed-in viewers with log
access. It is never exposed through the API — the job's check run reports
`output.summary: null` in both REST and GraphQL, and `/actions/jobs/{id}/logs`
returns `403` for a connection without log rights. This is platform-wide, not
repository-specific: a signed-out load of a public upstream repository's run
shows the same "Sign in to view logs" state. A check-run summary, by contrast,
is served by the public check-runs API and rendered on the Checks tab for
signed-out visitors on a public repository, and it survives the pull request
being closed and its branch deleted.

**How to apply:**
- Have the failing check write its report to a file named by an environment
  variable, then publish it from a separate `if: failure()` step. Each step
  gets its own step-summary file, so the two paths cannot share one.
- Bound the published copy: GitHub rejects an `output.summary` longer than
  65535 characters. Truncate by whole report lines and say how many lines were
  omitted.
- Always render generated content inside a backtick fence longer than any
  backtick run it contains.
- Acceptance for "a reviewer can read this" is an **unauthenticated** API read
  of `output.summary` plus a signed-out browser load of the Checks tab. A
  local test or a signed-in screenshot does not establish it.
