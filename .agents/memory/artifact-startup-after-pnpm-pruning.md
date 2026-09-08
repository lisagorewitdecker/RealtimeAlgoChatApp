---
name: Artifact cold-start readiness
description: Production startup guidance for static artifact servers with startup-indexed assets.
---

Open the production port before preloading generated assets, and perform the preload with asynchronous filesystem operations. A dependency-free server can still launch with `node` directly, but that does not solve blocking initialization.

**Why:** On Autoscale's cold deployment filesystem, synchronous asset preloading can exceed the port-readiness deadline even when the same preload is fast on the warm development filesystem. Replacing a package-manager wrapper with direct Node did not eliminate this bottleneck.

**How to apply:** Make lightweight landing and health routes available as soon as the listener starts. Populate the allowlisted asset map asynchronously, return a temporary unavailable response for asset requests until it is ready, and fail explicitly if preloading fails.