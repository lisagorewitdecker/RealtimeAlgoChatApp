---
name: Web crypto storage is session-only
description: Web device and room keys are intentionally scoped to one browser session.
---

Web device and room keys are intentionally session-only. A document reload is a new session, so recovery flows must model the previous session being superseded and use an explicit device-key reset before reopening encrypted content.

**Why:** Persisting cleartext private key material in browser storage would weaken the confidentiality boundary that the encrypted-room design is meant to preserve.

**How to apply:** Treat reloads as new-device/session events in browser validation. Assert supersession, reset explicitly through the supported recovery path, and verify a fresh encrypted envelope and decryption rather than restoring persistent cleartext key storage.
