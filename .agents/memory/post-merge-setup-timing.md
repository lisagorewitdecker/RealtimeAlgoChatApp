---
name: Post-merge setup timing
description: Why the configured post-merge timeout needs to accommodate locked dependency installation.
---

The post-merge setup needs a timeout that accommodates a cold `pnpm install --frozen-lockfile` before it runs database reconciliation; use a generous configured budget rather than the short default.

**Why:** Locked dependency installation can take well over the default 20 seconds even when it succeeds, causing a false setup failure before the remaining reconciliation commands run.

**How to apply:** When maintaining the merge hook, keep the installation step non-interactive and set the post-merge timeout based on observed cold-install duration with a buffer. After a timeout change, run the complete post-merge setup and confirm both setup and workflow reconciliation report success.