---
name: GitHub ruleset required status checks
description: Provider behavior for adding required status-check rules through the GitHub repository ruleset API.
---

When adding a required status-check rule through the GitHub ruleset API, omit
`integration_id` when the check is not tied to a specific GitHub App. Sending
`integration_id: null` can be rejected as an invalid ruleset property even
though the API documentation describes the field as optional.

**Why:** The repository ruleset API accepted the check only after the
provider-agnostic integration field was omitted.

**How to apply:** Preserve the existing ruleset fields and rules, add a
`required_status_checks` rule with the exact workflow check context, and verify
the stored ruleset after the update.

**Targeting (found 2026-09-19):** a ruleset whose `conditions.ref_name.include`
is `[]` targets no branch at all, so its rules (deletion, non-fast-forward,
required checks) are inert even while `enforcement` is `active` and the UI
lists them. Set `include: ["refs/heads/main"]` explicitly and confirm with
`GET /repos/{owner}/{repo}/rules/branches/main`, which lists only the rules
that actually apply. Required checks are matched against the job's display
`name`; check runs from `pull_request` events attach to the pull request head
SHA, which is why fast-forwarding `main` to that exact SHA satisfies the rule.
