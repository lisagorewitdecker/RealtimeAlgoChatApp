---
name: Account access policy
description: Server-authoritative rules for verifying DevStudio account access.
---

Use Clerk as the authority for DevStudio account access. An account may use the product only when its primary email is verified and its private account-access metadata does not mark it as banned.

**Why:** Client-supplied identity and existing session state are not trustworthy authorization signals. The same rule must protect normal JWT calls, short-lived room capabilities, reconnects, and active socket sessions.

**How to apply:** Route all new authenticated HTTP entry points through the shared account-access guard. Any new Socket.IO authentication path, including one based on an internally minted capability, must validate current Clerk access before admitting the socket. Preserve unrelated Clerk private metadata when changing account profile or access fields.