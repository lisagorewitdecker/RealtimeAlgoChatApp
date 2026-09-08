---
name: Socket.IO room join ordering
description: The ordering constraint for room presence and initial message events.
---

Register `room-joined`, `message`, `user-joined`, and `user-left` listeners before emitting `join-room`.

**Why:** A fast Socket.IO response can arrive before a listener is attached, leaving the client stuck showing zero participants even though the server accepted the join.

**How to apply:** Preserve this ordering whenever the room screen or another Socket.IO client is refactored, and verify the participant count after joining.