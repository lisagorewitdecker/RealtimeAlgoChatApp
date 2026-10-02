---
name: Preload modules must not build transport-backed loggers
description: How a static logger import in the Sentry preload produced an unbounded worker-thread chain that OOM-killed the whole workspace in development.
---
Nothing in a `--import` preload may execute off the main thread — not even a
static import whose module constructs a pino logger with a `transport`.

**Why:** Node worker threads inherit `--import` through `execArgv`, so the
preload runs again inside every pino transport worker. A static
`import { logger }` in the preload built another transport-backed logger in
each worker, which spawned another worker, which evaluated the preload again.
The API Server process grew by ~130 MB and two OS threads every second with no
log output, was killed at 10 GB, and repeatedly took the container down
(exit 137, pid2 restarts). Production was unaffected only because the logger
has no transport when `NODE_ENV=production`.

**How to apply:**
- Keep the `isMainThread` check first and load anything with side effects
  (loggers, transports, pools) behind it with a dynamic `await import(...)`.
- A dev process that starts fine, serves requests, then silently balloons
  points at worker fan-out; sample `ls /proc/<pid>/task | wc -l` to confirm.
- The API Server test suite includes a preload regression test that samples
  the child's thread count; keep it green when touching the preload or logger.
