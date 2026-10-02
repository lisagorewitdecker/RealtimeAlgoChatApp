---
name: Validation workflow concurrency
description: Why repository-wide validation runs its heavy suites sequentially.
---

Run the API, Chat App, and browser validation workflows sequentially, and keep the heavyweight JavaScript test runners single-worker.

**Why:** Concurrent Vitest, Jest, and Chromium workers exhausted the available process resources, causing fork startup failures, five-minute test stalls, and Chromium launch timeouts even though every suite passed when serialized.

**How to apply:** Keep the top-level validation workflow sequential. Configure Vitest with one worker and Jest to run in-band when these package suites are part of repository completion validation.

**Update (September 2026):** task-completion validation launches every registered command at once; a six-way parallel run slowed
`tsc` about 8x and tripped fixed per-test timeouts (Jest 5s, Vitest 10s hooks) in suites that pass alone. The heavy commands are
therefore registered behind one shared `flock` (`/tmp/replit-heavy-validation.lock`) so they serialize however they are launched;
keep the lock prefix when editing those commands. The Chat App Jest setup also raises the testing library's 1s `waitFor` default
via `setupFilesAfterEnv` (RNTL cannot be required from `setupFiles`, where `expect` does not exist yet).
