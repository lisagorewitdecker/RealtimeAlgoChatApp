---
name: Static-server SAST taint
description: How to avoid false-positive path-traversal findings in the Expo static delivery server.
---

Keep request-time URL handling separate from filesystem access: load the known static build into an allowlisted asset map at startup, then let requests resolve only to map keys.

**Why:** The security scanner continued to report high-severity path traversal for request-derived filesystem reads even after decoded-path normalization, explicit root-boundary enforcement, stream-based reads, and narrow suppression comments.

**How to apply:** Preserve the startup indexing boundary, but preload asynchronously after opening the listener so cold filesystems cannot block port readiness. Do not reintroduce request-derived paths into `fs`; requests may only use normalized asset-map keys.