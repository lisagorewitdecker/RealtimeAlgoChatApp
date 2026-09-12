# Browser end-to-end verification

These Playwright scenarios use two disposable Clerk synthetic users whose email
addresses contain `+clerk_test`. It verifies each account with Clerk's
development code `424242` and creates a unique room.

The banned-room scenario bans the second user and checks the persistent
banned-room explanation before and after returning through the room list.

The key-reset recovery scenario has the second user reset their device
encryption key from Profile, verifies their fingerprint and persisted room-key
envelope both change, rejoins the live room, and confirms they can decrypt a new
message from the creator.

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

For key-reset recovery, run:

```sh
E2E_CHAT_URL="https://${REPLIT_EXPO_DEV_DOMAIN}" \
E2E_API_URL="https://${REPLIT_DEV_DOMAIN}" \
pnpm --filter @workspace/api-server run test:e2e:key-reset-recovery
```

The test script installs the Chromium revision pinned by `@playwright/test`
before launching the browser, so a fresh workspace does not depend on a
developer's existing Playwright cache.

Each test closes both browser contexts and deletes its unique room, database
profiles, room-key envelopes, and Clerk users in `finally`. Cleanup failures
are reported together with the original test failure.
