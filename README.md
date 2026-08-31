# Realtime DevAlgoChatApp (React Native)

Realtime DevAlgoChatApp is a real-time collaboration platform for developers, built around three modes in a single room: **Build** (collaborative code sandbox with an AI assistant), **Call** (voice/video), and **Ship** (chat and room coordination).

Every account is authenticated through Clerk. Any signed-in user with a verified email and an unbanned account gets full access to the product — there are no paid tiers or feature gates. Administrators (configured via an allowlist of Clerk user IDs) can search for accounts and ban or restore access.

## Structure

This is a pnpm monorepo. The product is split across three artifacts, each independently run and previewed:

```
artifacts/
  api-server/       Express + Socket.IO backend (auth, rooms, moderation, AI assistant proxy)
  chat-app/         Expo/React Native app (iOS, Android, Web) — the DevStudio client
  mockup-sandbox/   Design/preview sandbox used while iterating on UI components
```

See the `pnpm-workspace` skill / `pnpm-workspace.yaml` for the full workspace layout and shared packages.

## Stack

- **Monorepo:** pnpm workspaces, TypeScript
- **Backend:** Node.js, Express, Socket.IO, Pino logging
- **Frontend:** Expo (React Native + React Native Web), Expo Router
- **Auth:** Clerk (`@clerk/express`, `@clerk/expo`) — email/password with verified-email enforcement
- **AI assistant:** Anthropic, accessed only from the server (never exposed to the client)
- **Realtime:** Socket.IO rooms with signed, server-issued room capabilities

## Running the app

Each artifact has its own workflow that starts automatically in the Replit preview pane. To run things manually:

```bash
# Backend API + Socket.IO server
pnpm --filter @workspace/api-server run dev

# Expo client (chat app)
pnpm --filter @workspace/chat-app run dev
```

### Tests

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/chat-app run test
```

### Typecheck / build

```bash
pnpm run typecheck
pnpm run build
```

## Core features

- **Accounts:** Clerk-authenticated sign-up/sign-in, email verification, password reset via Clerk's email-code flow, editable display name and avatar emoji.
- **Rooms:** Create or join a room; each participant gets a signed, time-scoped capability token authorizing them for that room's chat, call, or sandbox.
- **Ship (chat):** Real-time messaging per room over Socket.IO.
- **Call:** Real-time voice/video within a room.
- **Build (sandbox):** Collaborative coding sandbox with an integrated AI assistant (server-mediated Anthropic access, rate-limited).
- **Moderation:** Admins can search for accounts by name or email, then ban or restore access. Bans are enforced everywhere — HTTP requests, socket connections/reconnects, and room capability issuance.

## Environment & secrets

Secrets (Clerk keys, admin allowlist, session secret, Anthropic access) are managed through Replit's environment secrets — see the `environment-secrets` skill. They are never committed to the repository.

## Notes for contributors

- Server-resolved Clerk identity always overrides any client-supplied identity claims.
- Room access is granted only via signed server-issued capabilities, not client-asserted room membership.
- See `replit.md` for project-specific conventions and decisions as they're recorded.
