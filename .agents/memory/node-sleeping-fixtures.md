---
name: Node sleeping fixtures
description: How to keep a Node test fixture alive while it waits to receive an operating-system signal.
---

Use an active event-loop handle, such as a timer, when a fixture must remain alive until it receives a signal. Awaiting a promise that never settles can make Node report unsettled top-level await and exit with status 13.

**Why:** A generated-client interruption fixture exited before the test could signal it because an unresolved promise alone did not keep the process alive.

**How to apply:** For child-process tests that sleep until SIGINT or SIGTERM, create a timer, server, or other active handle and let the signal terminate the process.
