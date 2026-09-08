---
name: Node preload paths
description: How Node resolves workspace files supplied through the production --import option.
---

Resolve hosted monorepo production entrypoints relative to the workspace root. Include the artifact directory in both the main entrypoint and any Node `--import` preload path.

**Why:** A real publish promotion logged both artifact processes starting from the workspace root; package-local paths produced a Node loader failure, neither declared service port opened, and promotion timed out. Artifact-local test working directories had hidden this mismatch.

**How to apply:** Make production run commands workspace-root-relative and validate them by spawning from the workspace root. Keep a leading `./` on Node `--import` file paths so Node treats them as files rather than package specifiers. Treat each artifact's port and health route as part of the same startup contract.
