# SEO Strategy

## Product summary
DevStudio (DevAlgoChat) is a real-time collaboration platform for developers
(Build/Call/Ship: collaborative code sandbox + AI assistant, voice/video calls,
and chat). Every feature requires a Clerk-authenticated, verified-email
account — there are no free/public content areas, no paid marketing tiers,
and no blog/docs site in this repo.

## Repo shape (3 artifacts)
- `artifacts/api-server` — Express + Socket.IO JSON API only. No HTML pages,
  no public content. Out of scope for SEO.
- `artifacts/chat-app` — Expo/React Native app (iOS, Android, Web). This is
  the product itself. Every screen (`(auth)/sign-in`, `(auth)/sign-up`,
  `(tabs)`, `room/[roomId]`, `call/[roomId]`, `setup`, `profile`) is either
  behind auth or is a native-app-only route not reachable as a rendered web
  page — the production web server (`server/serve.js`) only serves a static
  Expo/QR "install the app" gateway page at `/` (built from
  `server/templates/landing-page.html`) plus `/status` and Expo Go manifest
  JSON at `/manifest`. Every other path 404s (no SPA-fallback soft-404 risk).
- `artifacts/mockup-sandbox` — internal design/component-preview sandbox
  (`kind: design`, preview path `/__mockup`). Internal tool; out of scope.

## In scope for this scan
- The single public surface: the app-install gateway page served at `/`
  (source: `artifacts/chat-app/server/templates/landing-page.html`,
  `artifacts/chat-app/server/serve.js`). This is the only URL an anonymous
  visitor, search crawler, or social-preview bot can ever see with content.

## Out of scope
- All authenticated app screens under `artifacts/chat-app/app/**`
  (sign-in/sign-up forms, tabs, rooms, calls, sandbox, profile, moderation) —
  these require a signed-in, verified-email account and are never rendered
  as indexable/shareable web pages.
- `artifacts/api-server` — pure JSON API, no HTML surface.
- `artifacts/mockup-sandbox` — internal design tool.

## Target audience
- Developers looking for a real-time pair-collaboration tool (code sandbox +
  call + chat). The install-gateway page's job is to get a visiting developer
  to install/open the app, not to rank for informational search queries.

## Primary keywords
- None identified — the product has no content marketing surface. The only
  discoverability lever in source is the install-gateway page's `<title>`,
  description, and social-preview tags.

## Crawler/GEO posture
- No `robots.txt` exists; default (implicit allow-all) is appropriate since
  there is nothing sensitive to hide and only one public route exists.
- No Cloudflare usage detected in source — deployed directly via Replit
  autoscale deployment (`.replit`), so no silent AI-bot blocking risk from a
  CDN layer.
- No `llms.txt` — acceptable at this scale (single utility page, not a
  content site); not filed as an issue.

## Dismissed categories
- Sitemap/robots.txt build-out — not filed; the site has exactly one public
  route and default-allow crawling already covers it.
- SPA-invisible-content findings for authenticated app screens — not filed;
  those routes are correctly gated behind auth and are out of scope per
  `<core_principles>` ("skip authenticated dashboards... unless explicitly
  included").
