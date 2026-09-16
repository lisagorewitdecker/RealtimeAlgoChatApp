---
name: Message deletion reconciliation
description: Ordering rules for reconciling soft-deleted realtime messages after disconnects and cold room hydration.
---

Persisted deletion tombstones must use their own bounded cursor and room-scoped index. Clients must also retain live deletion IDs while recovery is in flight and reject those IDs from later recovery or join payloads.

**Why:** Active-message reads, deletion writes, live events, and recovery pages can complete in different orders. A stale active row can otherwise arrive after its deletion signal and resurrect a moderated message. Cold hydration also has a gap before a socket joins the room, so its bounded loaded window needs one active-row recheck after live delivery is attached.

**How to apply:** Whenever message replay or room hydration changes, test deletion before and after socket attachment, deletion before a stale recovery page, legacy recovery payloads, and pagination of the deletion cursor. Never apply a bounded active-ID result to rows outside the checked batch.