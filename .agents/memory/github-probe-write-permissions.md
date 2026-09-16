---
name: GitHub probe write permissions
description: Permission check required before using the connected GitHub account for temporary CI probe pull requests.
---

Before planning a live GitHub CI probe, verify that the connected account can create commit trees or file contents, not only branch references and comments. The current connected account can create Git data and pull requests, but hosted job-log downloads still require an admin-scoped token.

**Why:** An earlier connection could create and delete refs and post pull-request comments, but commit-tree, contents, and GraphQL commit mutations were denied. On September 15, 2026, the live connection reported repository admin/push permission and successfully created a blob, tree, commit, branch, and temporary pull request; the Actions job-log endpoint still returned 403.

**How to apply:** Probe commit or contents write access before creating temporary refs. If writes are denied, remove any empty probe branch and ask an authorized collaborator for a PR whose changed files and workflow run can be inspected directly. If writes succeed but logs are needed, verify whether the connection has the separate admin Actions scope before relying on raw log download.
