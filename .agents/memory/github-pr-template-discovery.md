---
name: GitHub PR template discovery
description: Why live pull request template checks must target the repository default branch.
---

GitHub discovers the standard pull request template from the repository’s live default branch, not from an unpublished workspace branch or the proposed head branch.

**Why:** A generated template can pass local and CI content checks while GitHub’s new-pull-request form remains empty if the live default branch does not contain the file.

**How to apply:** When validating pull request form behavior, first query the repository’s actual default branch and confirm the template exists there. Treat local file validation and live form discovery as separate checks.
