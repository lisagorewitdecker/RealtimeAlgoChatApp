---
name: Realtime resource budgets
description: Durable design rule for Socket.IO collaboration resource controls.
---

Every realtime surface needs bounded admission and bounded work: cap connections by account, IP, and process; rate- and byte-limit events across all sockets for an account; cap room and direct fanout; and admit persistence before mutating or broadcasting state.

**Why:** Socket.IO handlers bypass normal HTTP middleware, so request-level limits do not protect handshakes, event floods, or outbound amplification. A persistence queue that fills after broadcast can also publish state that cannot survive recovery.

**How to apply:** Keep limits server-side and shared across an account's sockets. Make cleanup idempotent on disconnect and expiry, use trusted-proxy-aware client IPs, and reject work before allocating durable or broadcast state when a bounded queue is full.
