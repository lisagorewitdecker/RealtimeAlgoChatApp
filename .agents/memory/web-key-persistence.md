---
name: Web E2EE key persistence
description: Web device/room keys stay in localStorage by owner decision (accepted cleartext-storage scan risk); jest-expo has no localStorage.
---

**Rule:** On web, the device keypair and room keys live in `localStorage` and must survive a page reload. Do not move them into memory-only or session storage, and do not purge existing entries, even to satisfy a code-scanning "cleartext storage of sensitive information" finding. The owner made this call on 2026-09-17 and treats that finding as an accepted risk, dismissed on the GitHub side.

**Why:** A device identity that does not survive a reload registers a brand-new key on every refresh. The server correctly rejects the stale one, and the only way forward is a reset that supersedes the account's other devices and orphans the envelopes sent to the discarded key. The `key-reset-recovery` browser E2E covers exactly that reload path and blocks every task's completion validation when persistence is broken.

**How to apply:**
- A `key-reset-recovery` failure with "Replaced by another device or session" right after `page.reload()` is a web persistence regression first, not an environment problem.
- To intentionally cover the fresh-device superseded path, E2E may remove only that account's `devstudio_device_keypair_v1:` and `devstudio_roomkey:` entries before reload; keep Clerk/session storage intact.
- Security autofixes that arrive through GitHub can target these storage helpers; run the browser E2E before trusting a green Jest suite.
- jest-expo has no `localStorage`, so `globalThis.localStorage?.…` assertions pass vacuously. The web tests install an in-memory Storage stub and assert through the instance; keep that pattern.
