---
name: Browser E2E phase budgets
description: Release-critical browser checks should bound and label external setup, navigation, assertions, and teardown separately.
---

Treat browser E2E setup and cleanup as external operations that can stall independently of the product flow. Give authentication, navigation, room-state assertions, Clerk/database cleanup, and pool shutdown explicit deadlines; run independent teardown concurrently and preserve the phase in the failure message.

**Why:** A single Playwright test timeout makes an authentication or cleanup stall look like a moderation regression and can leave synthetic users or rooms behind.

**How to apply:** For release-critical scenarios, use named phase wrappers, bounded external calls, and cleanup via `Promise.allSettled`; keep the total test timeout above the sum of the sequential phases but below the old unbounded ceiling.