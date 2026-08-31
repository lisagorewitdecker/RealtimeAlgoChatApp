---
name: pnpm drizzle-orm / OpenTelemetry peer duplication
description: Adding an @opentelemetry/api-dependent package (e.g. @sentry/node) alongside drizzle-orm in the same pnpm package forks drizzle-orm into two incompatible type instances.
---

drizzle-orm has an optional peer on `@opentelemetry/api`. When a package (e.g. `artifacts/api-server`) directly depends on both `drizzle-orm` and something that pulls in `@opentelemetry/api` (like `@sentry/node`), pnpm builds two physical variants of drizzle-orm in the store: one linked against `@opentelemetry/api`, one plain. Any file that imports operators from `"drizzle-orm"` directly *and* from a shared `@workspace/db`-style package that resolves the other variant fails to typecheck — the two `SQL<>` classes are structurally identical but nominally distinct (private field branding).

**Why:** pnpm's peer-dependency resolution is per-importer; it forks a dependency into a separate build whenever an optional peer becomes reachable for that importer but not for others that also depend on the same package.

**How to apply:** If this happens, add the same `@opentelemetry/api` version as an explicit dependency to the shared package that owns the canonical drizzle-orm instance (e.g. `lib/db`) so every consumer converges on the otel-linked variant instead of forking. After doing this, also check esbuild's `external` list for any `@opentelemetry/*` wildcard — bundlers that externalize it will fail at runtime with `ERR_MODULE_NOT_FOUND: @opentelemetry/api` unless the package is actually hoisted to that artifact's own `node_modules`; removing the wildcard (bundling `@opentelemetry/api` itself, a pure JS interface package) is simpler than fixing hoisting. Also watch for Metro (Expo) file-watcher `ENOENT` crashes on `drizzle-orm_tmp_*` scratch directories that appear transiently right after this kind of install — restart the affected workflow once the install has fully settled before concluding it's broken.
