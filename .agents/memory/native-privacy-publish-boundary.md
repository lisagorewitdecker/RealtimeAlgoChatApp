---
name: Native privacy publish boundary
description: Native privacy failures need an end-to-end publish-boundary regression, not only checker assertions.
---

When a native privacy checker fails inside a store-publish job, test the reviewer summary branch and the submission boundary together. The checker can be safely redacted while a later summary or submission guard regresses independently.

**Why:** A failed step may still need an `always()` summary, while the store command must remain unreachable and fixture contents must stay out of reviewer-visible output.

**How to apply:** Use a controlled failing fixture, assert `BLOCKED` summary text and redaction, and verify a simulated submission marker is absent after the failed check.