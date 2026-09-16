---
name: Account-access lookup deadline
description: Why server-side Clerk lookups need a hard total deadline (not just per-wait caps) and how retry hints reach clients.
---

**Rule:** A server-side account-access lookup must settle — allow, deny, or "unavailable, retry in N s" — well inside Socket.IO's 45 s namespace connect timeout and typical 30–60 s proxy timeouts. Enforce that as one hard wall-clock deadline for the whole lookup (sleeps *and* in-flight requests), and when giving up, hand the client Clerk's capped guidance for the next attempt (`Retry-After` on HTTP, `connect_error` `data.retryAfterSeconds` on sockets).

**Why:** Per-wait caps alone still allowed ~90 s of holding across retries, and a request that never returns is not bounded by any sleep check. Socket.IO silently closes handshakes that exceed `connectTimeout`, so users saw a frozen app instead of an answer. A code review rejected a budget that only gated sleeps.

**How to apply:**
- Keep the deadline shorter than the per-wait cap on purpose: a capped hint that does not fit is passed to the client, never waited out server-side.
- The Clerk backend SDK (3.x) offers no abort signal or fetch override; race requests against the remaining time and discard late results. Do not treat a per-wait cap as a deadline.
- Treat this failure as an upstream condition in the socket handshake (warn log + auth-failure rate alert), not a per-handshake Sentry exception.
- Test-mock constraint in this codebase: many tests mock the lookup module with a bare factory, and vitest throws on access to an export the factory omits. Error classes and constants that HTTP/socket consumers need at runtime must live in a sibling module, not in the mocked one.
