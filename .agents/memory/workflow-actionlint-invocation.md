---
name: Workflow actionlint invocation
description: Reliable repository-wide GitHub Actions linting with the installed actionlint wrapper.
---

When the installed actionlint wrapper reports third-party action runtime deprecations, preserve structural, expression, runner-label, and configuration-variable checks; suppress only the exact non-structural deprecation family that is intentionally deferred. Run the workflow files sequentially when a multi-file invocation does not apply the same filtering consistently.

**Why:** The repository mixes pinned action SHAs with older version tags, and the wrapper's multi-file scan did not consistently apply path-based ignores while individual workflow checks did.

**How to apply:** Keep `.github/actionlint.yaml` as the source for accepted self-hosted labels and configuration-variable behavior. Put any temporary warning-only exception in the validation command with a narrowly matched `-ignore`, and retain path/line output with `-oneline`.