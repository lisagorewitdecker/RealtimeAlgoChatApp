---
name: Socket tests time out on stale dev-DB rooms
description: api-server socket tests hang (5 s timeout, ROOM_INACTIVE) when the dev database rooms table holds leftover fixture rows with old last_accessed_at or is_active=false
---

api-server socket tests (socket.security/socket.assistant/socket.rooms) reuse fixed room IDs like `room-alpha`. The join-room handler rejects rooms whose persisted row is `is_active = false` or whose `last_accessed_at` is older than 24 h, emitting a `ROOM_INACTIVE` error the tests never await — the failure surfaces only as a 5 s test timeout in `connectCapability`, with no stack pointing at the database.

**Why:** Test runs insert these fixture rooms but never clean them up; rows age past the inactivity threshold (or are left deactivated by deactivation tests) and poison later runs. Mass-identical timestamps are a schema-push artifact, not real activity.

**How to apply:** When socket tests time out en masse at room join, check the dev DB before suspecting code: `select id, is_active, last_accessed_at from rooms where id = '<failing room id>'`. Repair with `update rooms set is_active = true, last_accessed_at = now() where ...`. Diagnose fast by running one test with `DEBUG="socket.io-parser"` and grepping for the emitted `error` packet. Long-term the tests need room-ID isolation or cleanup (follow-up worthy).
