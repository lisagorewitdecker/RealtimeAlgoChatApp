---
name: Socket.IO Sentry alerting
description: How to report Socket.IO auth-failure/disconnect spikes and handler crashes to Sentry without spamming
---

Socket.IO connection middleware and per-event handlers run outside Express's request/response cycle, so Express error handling does not see their errors. Async socket callbacks need their own try/catch and explicit error reporting.

For "rate is elevated" style alerts (auth failures, disconnects), don't call `Sentry.captureMessage` per event — track occurrences in a rolling time window and fire once a threshold is crossed, then stay silent for a cooldown period before re-arming. Otherwise a real spike floods Sentry with one issue per event instead of one actionable issue.

**Why:** a bad deploy or crash loop produces many auth failures/disconnects in seconds; per-event capture makes the real signal unreadable in Sentry, and a naive try/catch-free async handler lets crashes disappear into "unhandled rejection" logs instead of becoming a visible issue.

**How to apply:** wrap async socket handlers at their event boundary. For elevated-rate alerts, use a rolling window, threshold, and cooldown. Read disconnect reasons from the disconnect event argument rather than socket metadata.
