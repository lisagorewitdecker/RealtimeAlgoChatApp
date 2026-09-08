---
name: Clerk account search
description: How to let an admin find a Clerk-backed account by name or email without building custom search infrastructure.
---

Clerk's backend SDK (`clerkClient.users.getUserList({ query, limit })`) already
performs a case-insensitive partial match across email addresses, phone
numbers, usernames, Web3 wallets, user IDs, first names, and last names.

**Why:** It's tempting to build a custom search index or maintain a searchable
mirror of account data, but Clerk already indexes this. Duplicating it adds a
sync-drift risk (the mirror can lag or diverge from the real account state).

**How to apply:** For an admin "find an account" feature, call `getUserList`
with the admin-provided query server-side, gated behind the existing
admin-only authorization check, and return only the minimal fields the admin
needs (id, display name, email, status) — never the full Clerk user record.
