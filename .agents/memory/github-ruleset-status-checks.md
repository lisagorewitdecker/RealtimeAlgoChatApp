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
