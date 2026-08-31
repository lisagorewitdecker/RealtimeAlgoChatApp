---
name: Drizzle schema must mirror every live table
description: Why lib/db/src/schema/index.ts must export a pgTable for every table that actually exists in the database, and how to check before trusting it.
---

`scripts/post-merge.sh` runs `drizzle-kit push --force` against the real database using `lib/db/src/schema/index.ts` as the source of truth. Any live table with no corresponding `pgTable` export is invisible to Drizzle and gets dropped on the next forced push.

**Why:** this repo's schema index once only re-exported two of eleven live tables (the rest — rooms, messages, room_members, room_bans, room_key_envelopes, sandbox_states, user_profiles, conversations, ai_messages — existed physically but had no schema file, likely lost in an earlier history rewrite). Nothing failed loudly; it would have silently deleted those tables the next time a merge ran the post-merge push.

**How to apply:** before trusting `lib/db/src/schema/index.ts`, compare it against reality: `psql "$DATABASE_URL" -c "\dt"` lists live tables; grep the schema directory for `pgTable(` calls. If a live table has no matching export, reconstruct it from `psql "\d <table>"` (exact columns/types/defaults/PKs/FKs) before any push-force runs, or the merge will drop real data.
