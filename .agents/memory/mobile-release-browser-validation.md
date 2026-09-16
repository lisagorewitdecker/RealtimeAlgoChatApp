---
name: Mobile release browser validation
description: Environment guidance for browser E2E checks against the proxied Expo and API artifact workflows, including stale-server mismatches after a rebase
---

The mobile release browser E2E depends on both the API service and the Expo dev bundle being healthy and freshly served. A page-level `Failed to fetch` or a long setup timeout can be a stale or mismatched workflow pair rather than an application-flow regression.

**Why:** In the proxied development environment, restarting only the backend can leave the browser exercising an older Expo bundle or an unhealthy frontend/API pairing; refreshing both artifact workflows restored the same E2E flow without an app-code change.

**How to apply:** Before changing the product flow for a proxied mobile E2E timeout, verify API health and restart the managed API and Expo workflows once as a pair. Then rerun the single affected flow.

## The API server is a one-shot build; a rebase silently leaves it stale

The API Server workflow's `dev` script builds once and then starts the bundle, so it does not pick up file changes. Metro serves the Expo client straight from the working tree. After a task rebase (for example, the rebase performed by task completion) pulls in API changes from main, the browser runs new client code against an old server until the API workflow is restarted.

**Why:** A reconnect-delivery E2E that had passed three times started failing deterministically (82 of 86 replayed messages) right after a rebase brought in main's cursor-based replay and `recover-messages` handler; the running server, built before the rebase, did not implement them. Restarting the API workflow fixed it with no code change.

**How to apply:** When a live E2E fails right after a rebase or merge that touched `artifacts/api-server`, compare the server process start time with the rebase time before debugging application code. Restart the API workflow and rerun the single flow first; a deterministic failure that appears only after a rebase is a stale-build signal, not evidence of a flake.
