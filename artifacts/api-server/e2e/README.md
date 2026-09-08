# Banned-room browser verification

This Playwright scenario uses two disposable Clerk synthetic users whose email
addresses contain `+clerk_test`. It verifies each account with Clerk's
development code `424242`, creates a unique room, bans the second user, and
checks the persistent banned-room explanation before and after returning
through the room list.

## Prerequisites

- The API Server and Chat App Expo workflows are running.
- `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are available as Replit
  Secrets for a Clerk development instance.
- Native Chromium runtime libraries are installed.

## Run

From the workspace root:

```sh
E2E_CHAT_URL="https://${REPLIT_EXPO_DEV_DOMAIN}" \
E2E_API_URL="https://${REPLIT_DEV_DOMAIN}" \
pnpm --filter @workspace/api-server run test:e2e:banned-room
```

The test script installs the Chromium revision pinned by `@playwright/test`
before launching the browser, so a fresh workspace does not depend on a
developer's existing Playwright cache.

The test closes both browser contexts and deletes its unique room, database
profiles, and Clerk users in `finally`. Cleanup failures are reported together
with the original test failure.