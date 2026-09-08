---
name: Validation workflow concurrency
description: Why repository-wide validation runs its heavy suites sequentially.
---

Run the API, Chat App, and browser validation workflows sequentially, and keep the heavyweight JavaScript test runners single-worker.

**Why:** Concurrent Vitest, Jest, and Chromium workers exhausted the available process resources, causing fork startup failures, five-minute test stalls, and Chromium launch timeouts even though every suite passed when serialized.

**How to apply:** Keep the top-level validation workflow sequential. Configure Vitest with one worker and Jest to run in-band when these package suites are part of repository completion validation.