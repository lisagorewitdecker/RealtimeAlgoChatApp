---
name: E2EE key registration ordering
description: Ordering requirements between device public-key registration, device-key rotation, and encrypted room entry.
---

An encrypted-room client must wait until the server confirms the current public key before joining or requesting room-key envelopes.

**Why:** If room presence starts first, peers can observe a missing or stale key and skip the envelope fan-out; a later registration does not replay that join event, leaving the device unable to decrypt the room.

**How to apply:** Keep key registration retryable and gate encrypted room subscriptions on confirmed registration whenever authentication, socket startup, or crypto initialization is changed.

## Rotating the device key (user-facing reset)

- Keep locally saved room keys when rotating the device keypair. The server only accepts room-key envelopes from a room's creator, so wiping local room keys would permanently lose every room the device created.
- Persist the new secret key before swapping the in-memory identity; a storage failure must leave the device on the identity the server already knows.
- Refuse a rotation while the current key is still loading or registering, and refuse re-entrant rotations.
- Drop readiness on rotation so the room screen leaves and only re-joins after the replacement key is confirmed; a re-join emits `user-joined` with the new key, which is what makes the creator send a fresh envelope.
- Room presence is keyed by account, not socket. While another session of the same account (second device, or the call socket) stays joined, leave/re-join produces no `user-left`/`user-joined`, so a key change must be announced explicitly (`user-key-changed`) or the creator never re-sends the envelope and the reset device waits forever.

## Replacement key ordering (no timeout bypass)

A replacement key must wait, unbounded, for every earlier unsettled registration request of the same account before it is sent.

**Why:** A bounded wait that "gives up" on a slow old-key write is an ordering bypass; the server's compare-and-set guard refuses the late write, but the client would then sit in a confusing conflict state for its own account. A hung request is fail-closed (rooms stay blocked); an ordering bypass is not.

**How to apply:** Any new code path that sends a device public key to the server must go through the provider's single registration loop. Do not add timeouts that let a newer request overtake an older one; if slow requests need UX feedback, add a warning state, not a bypass.

## Server-side registration is compare-and-set, never last-write-wins

Public-key writes are guarded by the key they replace: a write without an asserted previous key may only fill an empty slot or re-send the same key; replacing a different key requires naming it; anything else is a conflict that leaves the stored key untouched and reports the key the server kept.

**Why:** With unconditional upserts, a delayed or periodic registration from another device or session of the same account can land after a reset and silently re-advertise the old (possibly compromised) key while the reset client believes it is registered. Client-side ordering can only sequence one device's own requests; cross-session writes need the server guard.

**How to apply:** Startup registration is a plain write that never displaces another device (a conflict makes the device "superseded", not retrying). Only an explicit user reset performs a takeover, and it asserts the key it just read back, retrying a bounded number of times when another takeover races it. Keep the guard a single atomic statement so concurrent takeovers serialize on the row. Rosters and key-change notices that show a different key for the device's own account are authoritative conflicts and must close encrypted rooms.

Versioned replacements advance the server's authoritative account revision by exactly one. Never use a client timestamp or accept an arbitrary larger value.

**Why:** Device clocks and local counters are not globally ordered. A future-skewed or maximum client value could otherwise block every later reset, turning sequencing into a durable denial of key recovery.

**How to apply:** Read the server revision before an intentional takeover, submit only the next revision, and re-read/retry after stale or ahead responses. Preserve the new local identity while retrying, but do not mark it ready until the server confirms its key.

## Creator-account recovery needs a handover, not just re-registration

A fresh device of the room creator's account cannot receive its own rooms' keys from anyone but a session of the same account that still holds them, so a superseded creator session must hand its room key to the account's new key before it closes the room.

**Why:** Only the creator may distribute room keys, and creators never store an envelope for themselves. Without an explicit handover the new device waits forever, which contradicts the reset's recovery promise.

**How to apply:** The server authenticates a handover by the key the registry recorded as displaced (self-target only, creator only); the client sends it wherever it learns its own key was superseded (join roster or key-change notice), after local key hydration and before leaving. A second reset rotates the displaced key, so stale sessions cannot hand over after that; keep the confirmation copy honest that rooms without any surviving session cannot be recovered.
