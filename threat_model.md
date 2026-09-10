# Threat Model

## Project Overview

RealtimeAlgoChatApp Studio is a public, production-deployed collaboration platform with an Expo/React Native client and an Express 5 + Socket.IO API. The API uses Clerk for identity, PostgreSQL through Drizzle ORM for room, membership, message, profile, moderation, and encrypted-key-envelope state, and an Anthropic-backed coding assistant. Replit hosts the public autoscale deployment.

The product model intentionally grants every verified, unbanned account full product access. Rooms are create-or-join/shareable rooms rather than private tenant workspaces; the room ID is the access handle, and moderation bans/kicks are the room-level restriction mechanism. This must not be mistaken for a missing membership check unless the product model changes.

## Assets

- **Clerk accounts and sessions** — identity and session material; compromise permits impersonation and access to the product.
- **Room content and cryptographic material** — chat, shared source code/sandbox state, room keys, and key envelopes. The product and schema advertise E2EE for chat and sandbox content, so the server should not receive readable content even though verified users may intentionally join a room.
- **Profiles and moderation state** — usernames, avatars, public keys, bans, moderation history, and room state; unauthorized changes affect identity, privacy, and availability.
- **Administrative capabilities** — global account bans/restores and room moderation. Unauthorized use can disrupt accounts or rooms.
- **Application/integration secrets and data** — Clerk secret, session signing secret, database credentials, Anthropic credentials, and Sentry telemetry.

## Trust Boundaries

- **Public client to HTTP API** — requests are attacker-controlled and must establish Clerk identity. Room endpoints may grant access to a caller-selected/shareable room under the public-room model, but must still enforce authentication, account status, capability purpose, and ban/kick behavior.
- **Public client to Socket.IO** — handshake credentials and event payloads are untrusted. The server must authenticate the account, enforce capability room/purpose restrictions, validate event data, and never trust client-supplied identity fields.
- **API to PostgreSQL** — room, profile, moderation, and encrypted-state data cross into persistent storage. Queries must be parameterized; plaintext content must not be persisted when E2EE is promised.
- **API to external services** — Clerk, Anthropic, and Sentry receive or return security-sensitive data; secrets must remain server-side, and E2EE content should not be forwarded in plaintext to integrations without explicit user consent.
- **User to moderator/admin boundary** — global admin and room-creator moderation decisions must be server-enforced, not inferred from client flags or request fields.
- **Production to development/mockup boundary** — mockup and test helpers are not production surfaces unless a deployment route proves otherwise.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/index.ts`, `app.ts`, `routes/*.ts`, and `socket.ts`; client: `artifacts/chat-app/app`, `contexts`, `lib`, and `server/serve.js`.
- Highest-risk areas: `routes/rooms.ts`, `routes/moderation.ts`, `socket.ts`, `lib/roomAccess.ts`, `lib/accountAccess.ts`, `lib/sandboxAssistant.ts`, and Clerk middleware.
- Public surfaces include readiness/health, the Clerk proxy, vendor assets, and Socket.IO handshake; authenticated surfaces include room/profile/moderation and sandbox/assistant operations; admin routes are allowlisted and currently not mounted by the main route index.
- `artifacts/mockup-sandbox` and generated `dist`/maps, tests, and node_modules are dev/build artifacts unless production reachability is demonstrated.
- Room IDs are intentionally shareable access handles under the current product model. Do not report public room listing/joining as BOLA without evidence of a private-room requirement.

## Threat Categories

### Spoofing

Clerk session verification must run for every protected HTTP and Socket.IO path, and connection identity must not be taken from client-supplied user IDs. Tokens and room capabilities must be unguessable, scoped to their purpose and room, expiring, and rejected after account bans or room kicks where applicable.

### Tampering and Elevation of Privilege

Room creation, joining, messaging, sandbox updates, bans, kicks, and admin actions must validate inputs and enforce the intended public-room, room-creator, moderator, or administrator boundary. Client-supplied roles, owners, scopes, or actor IDs must not control authorization. Realtime events and assistant calls need bounded work so an authenticated account cannot exhaust shared service capacity.

### Information Disclosure

The advertised E2EE guarantee requires chat and shared-code payloads to be encrypted before crossing the API boundary, with public-key registration and room-key envelopes handled safely. The current chat and sandbox persistence paths accept ciphertext and nonce fields and should continue to avoid receiving or forwarding readable room content to storage, logs, or external AI services unless explicitly intended. Room-key envelope writes must be authorized and cryptographically bound to the intended key epoch and recipient; the current scan found an envelope-substitution path in the realtime handler. Profiles, moderation records, capabilities, and session material must not be over-disclosed.

### Injection and Unsafe File/URL Handling

All database access must use parameterized ORM expressions. User text and generated assistant output must not become executable HTML/JS in the app origin, shell commands, file paths, or unvalidated outbound URLs. The sandbox preview must stay isolated from the enclosing app and its credentials; proxy behavior must not permit attacker-controlled forwarding or secret leakage.

### Denial of Service

HTTP bodies, Socket.IO connections/events, sandbox broadcasts, assistant streams, and external calls must have account/IP/global work limits, bounded buffers, and timeouts. Client-side debounce is not a server control. The current scan found an authenticated realtime fanout/concurrency exhaustion path in `socket.ts`; see the reported finding.

### Repudiation and Monitoring

Sensitive moderation, admin, membership, and account actions should have reliable actor/timestamp audit records without logging tokens or private content. Production error telemetry must redact credentials and avoid making confidential room content part of third-party reports.
