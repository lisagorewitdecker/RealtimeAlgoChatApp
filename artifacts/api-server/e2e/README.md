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

The idle-profile scenario signs in one client, observes its successful
public-key registration at the API boundary, then leaves the client untouched
for 75 seconds. It fails if another public-key `PUT /api/profile` succeeds after
Clerk's token refresh interval.

The reduce-transparency tab bar scenario signs in one client, opens the Profile
tab, and reads the computed style of the classic tab bar that expo-router's
vendored react-navigation `BottomTabBar` renders, before and after pressing the
"Reduce transparency" switch. Off, the bar itself is transparent over the
palette's translucent `rgba(14, 17, 24, 0.85)` surface; on, the bar is the
opaque palette background (`#0E1118`) with no surface element, and it keeps its
top border, 84pt height, and absolute position.

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

For idle profile registration, run:

```sh
E2E_CHAT_URL="https://${REPLIT_EXPO_DEV_DOMAIN}" \
E2E_API_URL="https://${REPLIT_DEV_DOMAIN}" \
pnpm --filter @workspace/api-server run test:e2e:idle-profile-registration
```

For the reduce-transparency tab bar, run:

```sh
E2E_CHAT_URL="https://${REPLIT_EXPO_DEV_DOMAIN}" \
E2E_API_URL="https://${REPLIT_DEV_DOMAIN}" \
pnpm --filter @workspace/api-server run test:e2e:reduce-transparency-tab-bar
```

The test scripts install the Chromium revision pinned by `@playwright/test`
and run a browser-runtime preflight before recovery diagnostics. The Chromium
system libraries are declared in the Replit Nix package list. A missing browser
or runtime library therefore fails as an API-server browser setup error instead
of being reported as a recovery failure.

Each test closes both browser contexts and deletes its unique room, database
profiles, room-key envelopes, and Clerk users in `finally`. Cleanup failures
are reported together with the original test failure.
