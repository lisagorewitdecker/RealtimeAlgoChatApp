---
name: Metro evidence persistence
description: Keep opt-in Metro request evidence off the request path while preserving ordered rolling snapshots.
---

Metro request evidence persistence must enqueue immutable rolling snapshots in FIFO order; a storage failure is terminal for file writes, while console diagnostics continue independently.

**Why:** High-volume native preview traffic can otherwise make Metro wait on repeated full-file rewrites, and overlapping writes can let an older snapshot overwrite newer evidence.

**How to apply:** Keep request-finish handlers fire-and-forget, serialize asynchronous writes behind one queue, and convert write failures into one warning plus disabled persistence rather than unhandled rejections. Each write must also be atomic (sibling temp file + rename in the same directory): a plain writeFile truncates in place, so external pollers — or a reader right after a writer exits mid-queue — can observe an empty/partial evidence file even though a complete snapshot was written moments earlier.