---
name: Fork generated-client evidence
description: Keeps generated-client drift reports tied to the revision reviewed in fork pull requests.
---

Generated-client validation and its reviewer-visible drift check should use the
same pull-request head SHA. Do not validate a synthetic merge ref while
publishing evidence against the fork head, because the report can then describe
different source revisions than the check status reviewers inspect.

**Why:** Fork pull requests use a distinct checkout context, and GitHub's
default pull-request checkout can be a synthetic merge ref.

**How to apply:** For pull-request workflows, explicitly select
`github.event.pull_request.head.sha` for checkout and check-run identity, with
`github.sha` as the push-event fallback. Keep full history when the validation
or adjacent checks need repository history.