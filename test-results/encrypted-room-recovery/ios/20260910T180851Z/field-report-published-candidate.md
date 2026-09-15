# Field report — published candidate fails to open an encrypted room on a phone

**Result:** FAIL for the "open an encrypted room" step on the currently published
candidate. This is a single-phone, user-reported observation against the
production backend; it is **not** a substitute for the two-phone acceptance pass
and does not change the BLOCKED status in `../20260910T165152Z/validation-record.md`.  
**Recorded at (UTC):** 2026-09-10T18:08:51Z  
**Source:** the workspace owner, reporting from their own phone during this
session (platform inferred as iOS from an Expo Go screenshot shared in the same
session; phone model and OS version were not collected).  
**Procedure:** `artifacts/chat-app/docs/encrypted-room-recovery-device-check.md`

## Candidate and backend metadata (non-sensitive)

| Item | Value |
| --- | --- |
| Distribution | Expo Go project link served by the published deployment (`exps://devalgochat.com`), not a store/EAS binary |
| Published manifest ID | `5887e111-851a-49d0-b8d4-4f937f52f8b0` |
| Published bundle created (UTC) | 2026-09-08T20:08:33Z |
| Published runtime | `exposdk:54.0.0` (the workspace project is on Expo SDK 57.0.0; the SDK 57 publish has not been promoted) |
| Development preview version labels | Expo SDK 57.0.0 project; Expo Go client reported `57.0.5` in its user agent |
| Candidate includes native secure-storage key fix (`dddebef`, 2026-09-10)? | **No** — the published iOS bundle still contains the literal storage key template `devstudio_roomkey:${userId}:${roomId}` and none of the fix's strings |
| Backend | Production deployment (`https://devalgochat.com`, autoscale) |
| Accounts | The owner's own account; no test-account labels apply |
| Room plaintext / screenshots of room content | None collected |

## Observed behavior (as reported)

Opening an existing room from the published app stays on
**"Opening room… / Connecting securely to the conversation."** indefinitely.
No error, retry, or timeout is shown.

## Backend checks performed from the workspace (2026-09-10 ≈17:59–18:02 UTC)

| Check | Result |
| --- | --- |
| `GET /api/healthz` on the production domain | 200 (`{"status":"ok"}`), 0.16–1.5 s |
| Socket.IO handshake, HTTP long-polling, path `/api/socket.io` | 200, open packet returned |
| Socket.IO handshake, WebSocket, path `/api/socket.io` | opened in ~270 ms, open packet returned |
| Deployment log stream | empty for the whole retention window (`fetchDeploymentLogs` found nothing), so no server-side evidence is available either way |

The production API and realtime transport were reachable and healthy. Nothing
indicates a backend cause.

## Root cause (established from the published bundle and the code it was built from)

1. On phones, `expo-secure-store` rejects any key that is not made of
   `[A-Za-z0-9._-]`. The published candidate builds its room-key storage names
   with `:` separators, so `SecureStore.getItemAsync` **throws** when the room
   screen tries to load a saved room key (the same defect that blocks room
   creation with "Room key could not be saved" on phones).
2. In that candidate the room screen stores the resulting **rejected** promise
   and, when the server answers `room-joined`, chains its completion step with
   `.then(...)` on it. A rejected promise never runs `.then`, so the screen
   never leaves the loading state. Web is unaffected because browser storage
   accepts any key, which is why browser E2E never showed this.
3. Nothing in the flow times out or reports the error, so the user sees an
   endless "Opening room…".

## Remediation

- **Already in the workspace before this report:** storage key names are
  encoded into the secure-store alphabet (`lib/secureStorageKey.ts`), which
  removes the throw on phones.
- **Added in this change:** the room-key load can no longer reject. A secure
  storage read failure now surfaces as a "load" entry in
  `roomKeyPersistenceFailures`, the room and sandbox screens show
  "Saved encryption key could not be read" with a **Retry reading key** action,
  the retry re-reads storage (and restores the saved key without generating a
  replacement), a corrupted saved entry is ignored instead of failing the load,
  and both screens chain their hydration promise defensively so a rejection can
  never hang the join again. Regression tests cover the rejected-hydration hang,
  the read-failure recovery, and the corrupted-entry path.
- **Still required:** publishing a candidate built from a revision that
  includes both fixes. Until the SDK 57 publish bundling problem tracked
  separately is resolved and a new publish is promoted, the live app keeps the
  2026-09-08 bundle and this failure remains reproducible on every phone.

## Follow-up observation on the same phone (2026-09-10 ≈18:00–18:35 UTC)

While the published candidate was failing, the owner also tried the
**development preview** (Expo Go loading the workspace's SDK 57 dev server,
which runs the current source with both fixes) and reported Expo Go's
"There was a problem running the requested project. HTTP response error 404"
with Replit's "Run this app to see the results here" page as the body.

- The 404 body is Replit's placeholder for a workspace whose app server is
  not reachable, not a response from Metro or the API. The workspace had
  restarted at 17:43 UTC and ran heavy validation until ≈17:53 UTC; the
  screenshot was taken at 18:01 UTC.
- In-container probes of the preview domain could not settle the question
  because they reach the dev server through an internal sidecar rather than
  the public edge. An opt-in Metro request log (`EXPO_DEV_REQUEST_LOG=1`, see
  `artifacts/chat-app/metro.config.js`) was added so device requests can be
  seen directly.
- After a fresh QR scan the phone loaded the dev build: Expo Go
  (`Expo/57.0.5`, iOS 26.x) fetched the iOS bundle successfully, and the API
  log shows the same account registering its device public key, listing
  rooms, joining an existing room, and opening that room's shared sandbox
  (the sandbox WebView fetched its client scripts and joined the room
  channel). The native client is identifiable in the API log because it sends
  no CORS preflights, unlike the browser session that was active at the same
  time.
- A dev-server restart at 18:31 UTC (to enable the request log) made the
  phone reload once; it re-fetched the bundle within seconds and resumed.

This confirms, on one real iPhone and the development backend, that a
candidate built from the current source opens an encrypted room and its
sandbox where the published 2026-09-08 candidate hangs. It is still a
single-device, owner-driven observation without the matrix's controlled
steps (force-close, network loss, second device, non-participant), so no
matrix row is marked PASS from it.

## Effect on the acceptance matrix

This report supplies one real-device data point: the published candidate fails
"Open encrypted room / decrypt history" before any recovery step can be
attempted. It does not provide passing evidence for any matrix row on either
platform. The two-phone pass must still be run on a candidate that postdates
both fixes, per the runbook prerequisites.
