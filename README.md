# RealtimeAlgoChatApp

RealtimeAlgoChatApp Studio is a real-time collaboration platform for developers, built around three modes in a single room: **Build** (collaborative code sandbox with an optional AI assistant), **Call** (voice/video), and **Ship** (chat and room coordination).

Every account is authenticated through Clerk. Any signed-in user with a verified email and an unbanned account gets full access to the product — there are no paid tiers or feature gates. Administrators (configured via an allowlist of Clerk user IDs) can search for accounts and ban or restore access.

## Structure

This is a pnpm monorepo. The product is split across three artifacts, each independently run and previewed:

```
artifacts/
  api-server/       Express + Socket.IO backend (auth, rooms, moderation, AI assistant proxy)
  chat-app/         Expo/React Native app (iOS, Android, Web) — the RealtimeAlgoChatApp Studio client
  mockup-sandbox/   Design/preview sandbox used while iterating on UI components
```

See the `pnpm-workspace` skill / `pnpm-workspace.yaml` for the full workspace layout and shared packages.

## Stack

- **Monorepo:** pnpm workspaces, TypeScript
- **Backend:** Node.js, Express, Socket.IO, Pino logging
- **Frontend:** Expo (React Native + React Native Web), Expo Router
- **Auth:** Clerk (`@clerk/express`, `@clerk/expo`) — email/password with verified-email enforcement
- **AI assistant:** Anthropic Claude, accessed only from the server (never exposed to the client); using the opt-in helper sends the current sandbox HTML/CSS/JS and question readable to Anthropic outside the room's end-to-end encryption
- **Realtime:** Socket.IO rooms with signed, server-issued room capabilities

## Running the app

The Replit Run button starts the `Project` workflow (defined in `.replit`), which runs `chat-app-preview-startup` and validation workflows in parallel. To run things manually:

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
- **Build (sandbox):** Collaborative coding sandbox with an optional, rate-limited AI assistant. The sandbox shows a privacy notice before the first use; after confirmation, each question sends the current HTML/CSS/JS and question readable to Anthropic outside the room's end-to-end encryption. Chat messages, room keys, and capability tokens are not sent.
- **Moderation:** Admins can search for accounts by name or email, then ban or restore access. Bans are enforced everywhere — HTTP requests, socket connections/reconnects, and room capability issuance.
- **Device encryption identity:** Each signed-in device holds its own end-to-end encryption keypair (private key in SecureStore/Keychain, public key registered with the account). The Profile tab's "Device encryption" card shows the registration state and a public-key fingerprint, and offers **Reset device encryption key** for recovery after a reinstall or a suspected device compromise. The reset explains its impact before confirming, keeps room keys already saved on the device, and blocks encrypted-room joins until the server confirms the new public key; room creators then deliver fresh room-key envelopes to the new identity (when another session of the same account is still in the room, the server announces the changed key with a `user-key-changed` event so the creator re-sends the envelope). Public-key registration is compare-and-set on the server: `PUT /api/profile` without `previousPublicKey` can only register a first key or re-send the current one, replacing a different key requires naming it, and any other write is refused with `409 PUBLIC_KEY_CONFLICT` (leaving the stored key unchanged). A device whose plain registration is refused, or that sees a different key for its account in a room roster or `user-key-changed` notice, reports itself as **superseded** and closes encrypted rooms until the user resets there; the reset takes over from the key it read back and retries a bounded number of times if another takeover races it. A replacement records the key it displaced, and a still-signed-in creator session whose key was displaced hands its retained room key to the account's new key (a self-targeted `room-key-envelope` under the displaced key) while it has the room open, so a fresh device can recover rooms the account created; the server accepts that handover only from the room creator, only for the creator's own account, and only under the most recently displaced key. The reset does not sign out other devices or sessions, and room keys already delivered to the old key remain readable to anyone holding the old private key.

## Environment & secrets

Secrets (Clerk keys, admin allowlist, session secret, Anthropic access) are managed through Replit's environment secrets — see the `environment-secrets` skill. They are never committed to the repository.

## Notes for contributors

- Server-resolved Clerk identity always overrides any client-supplied identity claims.
- Room access is granted only via signed server-issued capabilities, not client-asserted room membership.
- See `replit.md` for project-specific conventions and decisions as they're recorded.

[![Mobile release accessibility gate](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/workflows/mobile-release.yml/badge.svg?branch=main)](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/workflows/mobile-release.yml)
