---
name: E2EE key registration ordering
description: Ordering requirement between device public-key registration and encrypted room entry.
---

An encrypted-room client must wait until the server confirms the current public key before joining or requesting room-key envelopes.

**Why:** If room presence starts first, peers can observe a missing or stale key and skip the envelope fan-out; a later registration does not replay that join event, leaving the device unable to decrypt the room.

**How to apply:** Keep key registration retryable and gate encrypted room subscriptions on confirmed registration whenever authentication, socket startup, or crypto initialization is changed.
