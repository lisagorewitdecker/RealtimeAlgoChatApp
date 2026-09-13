---
name: GitHub probe write permissions
description: Permission check required before using the connected GitHub account for temporary CI probe pull requests.
---

Before planning a live GitHub CI probe, verify that the connected account can create commit trees or file contents, not only branch references and comments.

**Why:** The current GitHub connection could create and delete refs and post pull-request comments, but commit-tree, contents, and GraphQL commit mutations were denied. A branch ref without a writable commit cannot exercise a controlled workflow change.

**How to apply:** Probe commit or contents write access before creating temporary refs. If writes are denied, remove any empty probe branch and ask an authorized collaborator for a PR whose changed files and workflow run can be inspected directly.