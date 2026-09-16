---
name: E2EE assistant boundary
description: Confidentiality rule for AI features inside end-to-end encrypted rooms.
---

Do not forward room messages, room keys, capability tokens, or other encrypted-room content to a server-side AI integration. Sandbox source may be sent only through the separate, explicit disclosure flow: the user must confirm that the current HTML/CSS/JS and their question leave the room readable and are not covered by end-to-end encryption.

**Why:** A server-side model request requires the service to receive readable content, which contradicts the advertised boundary that only room participants can decrypt it.

**How to apply:** Keep the Socket.IO assistant rejected unless the sandbox client carries the explicit acknowledgement. Show the disclosure before first use, remember the choice per device, keep the reminder visible, send only the current sandbox files and prompt, and render the response as text. Do not add assistant behavior to the encrypted chat surface.
