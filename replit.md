# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `SENTRY_DSN` — enables production error tracking and the `/api/healthz` uptime monitor in `artifacts/api-server` (see Gotchas)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Production error monitoring (Sentry) is wired into `artifacts/api-server` but needs `SENTRY_DSN` set to activate — without it, the server logs a warning and runs with no error reporting or uptime alerting. It captures uncaught exceptions/rejections, Express request errors, and reports a heartbeat check-in on `/api/healthz` every 5 min (Sentry Crons "missed check-in" = the server is down). Confirm in Sentry's dashboard that the `api-server-healthz` Cron Monitor and the project's issue alert rule actually have notifications turned on — that's dashboard-only config not settable from code.
- Socket.IO auth-failure/disconnect-rate Sentry alerts (`artifacts/api-server/src/lib/socketMonitoring.ts`) ship with conservative default thresholds because the app has no real production traffic yet to baseline against. Once real usage exists, retune without a code change via optional env vars: `SOCKET_AUTH_FAILURE_ALERT_THRESHOLD`/`_WINDOW_MS`/`_COOLDOWN_MS` and `SOCKET_DISCONNECT_ALERT_THRESHOLD`/`_WINDOW_MS`/`_COOLDOWN_MS` (all default if unset or invalid).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
