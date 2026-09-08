---
name: Mobile release browser validation
description: Environment guidance for browser E2E checks against the proxied Expo and API artifact workflows
---

The mobile release browser E2E depends on both the API service and the Expo dev bundle being healthy and freshly served. A page-level `Failed to fetch` or a long setup timeout can be a stale or mismatched workflow pair rather than an application-flow regression.

**Why:** In the proxied development environment, restarting only the backend can leave the browser exercising an older Expo bundle or an unhealthy frontend/API pairing; refreshing both artifact workflows restored the same E2E flow without an app-code change.

**How to apply:** Before changing the product flow for a proxied mobile E2E timeout, verify API health and restart the managed API and Expo workflows once as a pair. Then rerun the single affected flow.
