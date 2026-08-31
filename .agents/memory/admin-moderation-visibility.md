---
name: Admin moderation visibility
description: How workspace moderation controls discover the current account's administrator role safely.
---

Admin-only workspace controls must use a boolean derived by the authenticated
server for the current account. The client must never receive or duplicate the
administrator allowlist.

**Why:** UI visibility improves usability but is not authorization. Exposing or
mirroring administrator identifiers makes role configuration stale and
unnecessarily visible, while a changed allowlist must take effect immediately.

**How to apply:** Return only the current account's administrator state from an
authenticated profile/session response. Keep every sensitive moderation action
guarded by the server's administrator check, even when the client hides its
controls for non-administrators.