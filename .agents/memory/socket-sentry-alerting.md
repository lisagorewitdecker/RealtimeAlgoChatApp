---
name: Socket.IO Sentry alerting
description: Design lesson for reporting Socket.IO connection failures/spikes to Sentry without spamming or miscategorizing routine rejections
---

Socket.IO's connection middleware and per-event handlers run outside the web framework's request/response cycle, so a generic Express-level Sentry error handler never sees their errors. Every code path through the middleware (not just the branch that calls the token-verification library) needs its own explicit error handling, or a failure partway through silently drops the connection without being recorded anywhere.

Within that error handling, distinguish an expected, routine rejection (e.g. a normal user's expired/invalid token) from an unexpected one (e.g. a downstream service call throwing because it's down): only the latter is a bug/infra signal worth an exception capture. Capturing every routine rejection as an exception both miscategorizes it and produces one Sentry event per bad handshake.

For "rate is elevated" alerts (auth failures, disconnects), track occurrences in a rolling time window and fire once per threshold-crossing, then cool down before re-arming — not one alert per occurrence.

**Why:** unguarded branches and per-event capture both surfaced in review as ways this kind of monitoring silently misses real failures or drowns them in noise.

**How to apply:** whenever adding failure/crash reporting to a non-HTTP protocol handler (WebSockets, queues, cron jobs), audit every branch for unguarded error paths first, then separate "expected rejection" from "unexpected error" before deciding what gets an exception capture vs. just a counted occurrence. Read Socket.IO disconnect reasons from the disconnect event argument rather than socket metadata.
