---
name: Socket.IO client delivery
description: How the embedded collaboration pages load the Socket.IO browser client reliably.
---

The Socket.IO browser client must be delivered from an explicit server-managed vendor route when the API is bundled with esbuild.

**Why:** Socket.IO's automatic client serving relies on package files that are not reliably available in the output bundle, resulting in a successful page load that never starts a socket handshake.

**How to apply:** When changing the API build or Socket.IO configuration, retain a verified browser-client route and make embedded pages load that route rather than assuming the Socket.IO server's default client endpoint works.
