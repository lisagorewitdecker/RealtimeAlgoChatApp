---
name: Mobile release helper discovery
description: Static mobile release inventory checks must not silently stop following nested helper scripts.
---

The mobile release contract checker must scan the full supported helper depth and fail with a fixed, actionable diagnostic when another helper appears at the boundary.

**Why:** A silent depth cutoff can hide a summary writer or evidence reader from the inventory while the release workflow still succeeds.

**How to apply:** Keep the configured depth aligned with the current workflow chain, and add a regression fixture whenever the supported chain changes.