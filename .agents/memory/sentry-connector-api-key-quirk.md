---
name: Sentry connector management-API quirk
description: The Sentry connector's REST/Management API proxy can be unusable for api_key-type connections; use the DSN directly for error/uptime monitoring instead.
---

An `api_key`-type Sentry connection's `proxyFetch` calls to Sentry's Management/REST API (`/api/0/organizations/...`) can fail — either a 308 redirect loop on trailing slashes, or a server-side "Request cannot be constructed from a URL that includes credentials" error, because the connector's configured host was mis-set to something other than a Sentry API hostname.

**Why:** This is a connector/backend configuration bug, not a code or retry problem — different path/redirect variants all failed the same way, and `getIntegrationReauthorizationContext` confirmed `authorizationType: api_key` (not oauth2), so there is no reauthorization flow available to fix it.

**How to apply:** Don't force the Management API for Sentry project/DSN provisioning when it behaves this way. Instead, ask the user directly for their project's `SENTRY_DSN` (Settings → Client Keys) via `requestSecrets`, and build error capture + uptime alerting entirely on the DSN/ingest path: `Sentry.init({ dsn })` for uncaught exceptions/rejections and Express error handling, plus `Sentry.withMonitor(...)` (Cron Monitors "dead man's switch") for endpoint-down alerting — none of that needs the broken Management API. Note for the user that Sentry Cron Monitor alert notifications and default issue-alert rules are dashboard-only settings not controllable from code, so ask them to confirm those are turned on.
