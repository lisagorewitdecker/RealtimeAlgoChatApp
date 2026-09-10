---
name: Room key hydration must settle
description: Why the encrypted-room and sandbox screens must never wait on a promise that can reject, and how storage read failures are surfaced.
---

# Room key hydration promises must always settle

**Rule:** encryption-key restoration must never turn a recoverable storage
failure into an indefinite loading state. Storage failures need a visible,
retryable path; malformed or incorrectly sized keys must be treated as absent,
and no replacement key should be generated silently.

**Why:** on phones, a rejected secure-store read left the room screen chained
on a promise that never resolved, producing an endless "Opening room…" with no
error. Browser storage never rejected, so web E2E never showed it.

**How to apply:** any code path that waits on key hydration before finishing a
join or opening a sandbox must settle on both success and failure, validate the
secretbox key length before use, and preserve the existing key rather than
replacing it after a read error.
