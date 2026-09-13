---
name: E2EE assistant boundary
description: Confidentiality rule for AI features inside end-to-end encrypted rooms.
---

Do not forward room messages, sandbox source, or room-scoped prompts to a server-side AI integration from an end-to-end encrypted room.

**Why:** A server-side model request requires the service to receive readable content, which contradicts the advertised boundary that only room participants can decrypt it.

**How to apply:** Keep the assistant disabled for encrypted rooms unless a future design adds an explicit, informed client-side disclosure flow that is clearly separate from ordinary encrypted collaboration.