# Threat Model

## Project Overview

RealtimeAlgoChatApp Studio is a public, production-deployed collaboration
platform with an Expo/React Native client and an Express 5 + Socket.IO API. The
API uses Clerk for identity, PostgreSQL through Drizzle ORM for room,
membership, message, profile, moderation, and encrypted-key-envelope state, and
an Anthropic-backed coding assistant. Replit hosts the public autoscale
deployment.

The product model intentionally grants every verified, unbanned account full
product access. Rooms are create-or-join/shareable rooms rather than private
tenant workspaces; the room ID is the access handle, and moderation bans/kicks
are the room-level restriction mechanism. This must not be mistaken for a
missing membership check unless the product model changes.

## Assets

- **Clerk accounts and sessions** — identity and session material; compromise
  permits impersonation and access to the product.
- **Room content and cryptographic material** — chat, shared source
  code/sandbox state, room keys, and key envelopes. The product and schema
  advertise E2EE for chat and sandbox content, so the server should not receive
  readable content even though verified users may intentionally join a room.
- **Profiles and moderation state** — usernames, avatars, public keys, bans,
  moderation history, and room state; unauthorized changes affect identity,
  privacy, and availability.
- **Administrative capabilities** — global account bans/restores, room
  deactivation, and room moderation. Unauthorized use can disrupt accounts or
  rooms.
- **Application/integration secrets and data** — Clerk secret, session signing
  secret, database credentials, Anthropic credentials, and Sentry telemetry.

## Trust Boundaries

- **Public client to HTTP API** — requests are attacker-controlled and must
  establish Clerk identity. Room endpoints may grant access to a
  caller-selected/shareable room under the public-room model, but must still
  enforce authentication, account status, capability purpose, and ban/kick
  behavior.
- **Public client to Socket.IO** — handshake credentials and event payloads are
  untrusted. The server must authenticate the account, enforce capability
  room/purpose restrictions, validate event data, and never trust
  client-supplied identity fields.
- **API to PostgreSQL** — room, profile, moderation, and encrypted-state data
  cross into persistent storage. Queries must be parameterized; plaintext
  content must not be persisted when E2EE is promised.
- **API to external services** — Clerk, Anthropic, and Sentry receive or return
  security-sensitive data; secrets must remain server-side, and E2EE content
  should not be forwarded in plaintext to integrations without explicit user
  consent.
- **User to moderator/admin boundary** — global admin and room-creator
  moderation decisions must be server-enforced, not inferred from client flags
  or request fields.
- **Production to development/mockup boundary** — mockup and test helpers are
  not production surfaces unless a deployment route proves otherwise.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/index.ts`, `app.ts`,
  `routes/*.ts`, and `socket.ts`; client: `artifacts/chat-app/app`,
  `contexts`, `lib`, and `server/serve.js`.
- Highest-risk areas: `routes/rooms.ts`, `routes/moderation.ts`,
  `routes/admin.ts`, `socket.ts`, `lib/roomAccess.ts`, `lib/accountAccess.ts`,
  `lib/sandboxAssistant.ts`, and Clerk middleware.
- Public surfaces include readiness/health, the Clerk proxy, vendor assets, and
  the Socket.IO handshake; authenticated surfaces include
  room/profile/moderation and sandbox/assistant operations.
- The admin router is mounted at `/api/admin` (`routes/index.ts`). Every admin
  route runs `requireAuth` (Clerk session, verified email, not banned) and then
  checks the caller against the `ADMIN_USER_IDS` allowlist; the router also has
  its own per-IP rate limit.
- `artifacts/mockup-sandbox` and generated `dist`/maps, tests, and node_modules
  are dev/build artifacts unless production reachability is demonstrated.
  `lib/embedTickets.ts`, `lib/verifyToken.ts`, and `lib/profileWrites.ts` are
  not referenced by production routes.
- Room IDs are intentionally shareable access handles under the current
  product model. Do not report public room listing/joining as BOLA without
  evidence of a private-room requirement.

## Threat Categories

### Spoofing

Clerk session verification must run for every protected HTTP and Socket.IO
path, and connection identity must not be taken from client-supplied user IDs.
Tokens and room capabilities must be unguessable, scoped to their purpose and
room, expiring, and rejected after account bans or room kicks where applicable.

Session tokens whose `azp` (authorized party) claim names a browser origin
outside the deployment's own domains (`REPLIT_DEV_DOMAIN`,
`REPLIT_EXPO_DEV_DOMAIN`, `REPLIT_DOMAINS`, `REPLIT_INTERNAL_APP_DOMAIN`) are
rejected on HTTP (`requireAuthorizedUser`) and at the Socket.IO handshake.
Native app tokens carry no `azp` and are accepted; with no deployment domains
configured (local development, tests) the check is off.

Display names cannot impersonate the system or staff: "System", "Admin",
"Administrator", "Moderator", and the owner's display name are reserved for
`ADMIN_USER_IDS` accounts and the `MAIN_ADMIN_EMAIL` account. The comparison
ignores case, spacing, Unicode compatibility forms, invisible format
characters, and common Cyrillic/Greek/digit look-alikes. Names that were
already stored are still displayed.

### Tampering and Elevation of Privilege

Room creation, joining, messaging, sandbox updates, bans, kicks, and admin
actions must validate inputs and enforce the intended public-room,
room-creator, moderator, or administrator boundary. Client-supplied roles,
owners, scopes, or actor IDs must not control authorization. Realtime events
and assistant calls need bounded work so an authenticated account cannot
exhaust shared service capacity. Profile writes only accept avatars from the
server allowlist (`lib/profileAvatars.ts`); a value saved before the allowlist
may be re-sent unchanged.

### Information Disclosure

The advertised E2EE guarantee requires chat and shared-code payloads to be
encrypted before crossing the API boundary. The chat and sandbox persistence
paths accept ciphertext and nonce fields and should continue to avoid
receiving or forwarding readable room content to storage, logs, or external AI
services unless explicitly intended (the sandbox assistant sends code to
Anthropic only after an explicit per-request disclosure acknowledgement).
Profiles, moderation records, capabilities, and session material must not be
over-disclosed.

The E2EE trust model is limited, and reviewers should treat these as known
properties rather than new findings:

- **The server is trusted for key distribution.** Clients receive other
  members' public keys from the server (Socket.IO room membership events), and
  the room creator's client wraps the room key for each member using those
  keys. A malicious or compromised server could
  substitute a public key and read future room content. There is no
  out-of-band key verification.
- **Room-key envelope writes are restricted to the room creator** and must use
  the creator's currently registered public key (or, for a device handover,
  the key it displaced), so a joined member cannot replace another member's
  envelope.
- **No room-key rotation.** Kicking or banning a member does not rotate the
  room key, and the removed member's stored key envelope is not deleted. A
  room-banned or kicked account can still fetch its old envelope from
  `GET /api/rooms/:roomId/key-envelope` and, with access to ciphertext, read
  content encrypted under that key. (Globally banned accounts are blocked by
  `requireAuthorizedUser`.)
- **WebRTC signaling is relayed by the server.** Offers, answers, and ICE
  candidates pass through Socket.IO, so the server could tamper with call
  setup. Media itself is DTLS-SRTP between peers.

### Injection and Unsafe File/URL Handling

All database access must use parameterized ORM expressions. User text and
generated assistant output must not become executable HTML/JS in the app
origin, shell commands, file paths, or unvalidated outbound URLs. The sandbox
preview must stay isolated from the enclosing app and its credentials; proxy
behavior must not permit attacker-controlled forwarding or secret leakage.

Every API and chat-app static server response sends
`X-Content-Type-Options: nosniff`. The `/api/rooms/call` and
`/api/rooms/sandbox` HTML documents send
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`:
native apps load them as the WebView's top-level page and the web app renders
fetched sandbox markup through `iframe srcdoc`, so neither is framed by URL.
The chat-app landing page stays frameable (it has no authenticated or
state-changing actions). There is no full Content Security Policy.

### Denial of Service

HTTP bodies, Socket.IO connections/events, sandbox broadcasts, assistant
streams, and external calls must have account/IP/global work limits, bounded
buffers, and timeouts. Client-side debounce is not a server control. Socket
connections are capped per IP and per account, events are metered by
per-account and global event budgets, and database writes from realtime
handlers share a persistence budget. The sandbox
assistant cooldown is keyed by the Clerk account, so opening more sockets does
not bypass it; the separate "one request in progress" guard is still per
socket.

### Repudiation and Monitoring

Sensitive moderation, admin, membership, and account actions should have
reliable actor/timestamp audit records without logging tokens or private
content. Production error telemetry must redact credentials and avoid making
confidential room content part of third-party reports. Both the API and the
mobile app scrub Sentry events and breadcrumbs before sending: `Authorization`,
`Proxy-Authorization`, `Cookie`, and `Set-Cookie` headers, request cookies,
bearer tokens in messages, and token-like URL/query/data keys (`token`,
`capability`, Clerk `__session`, `__clerk_db_jwt`, `__clerk_handshake`, and
similar).

## Known Limitations and Deferred Work

These are accepted, documented gaps. Report them only with new impact.

- **No socket revocation on sign-out or Clerk session revocation.** A socket
  authenticated with a session token stays connected after that session ends;
  only account bans and room kicks/bans disconnect live sockets.
- **No room-key rotation** after kicks or bans (see Information Disclosure).
- **No full Content Security Policy** on the API or chat-app server; only the
  headers listed above.
- **`/api/ai/code-assist`** requires a signed-in, verified account but is only
  rate limited per IP (20 requests/minute per instance); there is no
  per-account quota.
- **`trust proxy` is set to one hop.** Per-IP rate limits assume exactly one
  trusted reverse proxy (Replit's) in front of the API; a different topology
  needs this setting revisited.
- **Rate limits, the assistant cooldown, and admin room
  deactivation/reactivation are instance-local.** With several API instances,
  each enforces its own limits. An admin room deactivation updates the
  database, but only the instance that served the request updates its
  in-memory room; other instances keep serving a room they already hold.
- **`getAccountAccess` has no cache.** Each protected HTTP request and socket
  handshake asks Clerk for the account's status (concurrent lookups for the
  same account share one request), so Clerk availability and rate limits bound
  API throughput.
- **The Sentry DSN appears in git history.** DSNs are public ingestion
  identifiers by design (the mobile app ships one); they do not grant read
  access to Sentry data.
- **`MAIN_ADMIN_EMAIL` must be configured** for the owner's account to keep
  using the owner's display name; when it is unset nobody receives main-admin
  treatment and the API logs a warning at startup.
