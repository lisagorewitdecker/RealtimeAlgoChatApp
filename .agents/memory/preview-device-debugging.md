---
name: Preview device debugging
description: How to tell what a phone actually fetched from the Expo dev preview, and why in-workspace probes and the "published app" can mislead.
---

# Debugging phones that cannot load the Expo preview

**Rule:** Do not conclude "the preview works" from curl inside the workspace.
Requests to `*.replit.dev` from the container resolve to an internal sidecar
(a private IP), so they never traverse the public edge the phone uses.
Replit's "Run this app to see the results here" HTML in an Expo Go 404 means
the public edge could not reach the workspace app server at that moment.

**How to see device traffic:** set `EXPO_DEV_REQUEST_LOG=1` in the development
environment and restart the Expo workflow; the Metro config then logs one line
per Metro-level request (status, host, platform, user agent, path). Manifest
requests are handled by Expo middleware before that hook and are not logged.
In the API access log, a native client is the one that sends no `OPTIONS`
preflights; browser tabs preflight every cross-origin call.

**"Published app" caveat:** the live domain serves an Expo Go manifest whose
bundle can be days behind HEAD. Check the production manifest `createdAt` and
`runtimeVersion` (curl the live root with an `expo-platform` header) before
diagnosing a "production" bug against current source.

**Why:** a real-iPhone "Opening room…" hang was a stale published bundle
(pre secure-store fix), and a same-day preview 404 was an edge/restart window;
both looked healthy from in-container probes.

**How to apply:** any time a user reports an Expo Go loading error or a
phone-only bug, capture the request log and compare manifest dates first.
