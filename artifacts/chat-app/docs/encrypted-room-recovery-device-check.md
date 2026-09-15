# Encrypted-room recovery device check

Run this two-phone acceptance pass on physical phones before a store release
that changes device-key registration, room-key envelopes, secure storage, room
join/rejoin, or the sandbox. It proves what Jest mocks, simulators, emulators,
Expo Go, and the browser preview cannot: Keychain/Keystore persistence,
force-close recovery, network-retry timing, and device-identity changes.

Evidence for each platform is stored under
`test-results/encrypted-room-recovery/<ios|android>/<UTC timestamp>/`. If the
prerequisites below are not available, write a `BLOCKED` record in that
location instead of substituting a simulator, emulator, Expo Go, or a
single-phone smoke test.

## Prerequisites

1. **A release candidate built from a revision that includes the native
   secure-storage key fix** (commit `dddebef`, 2026-09-10, or later) **and the
   room-key load hardening that followed it** (the room screen must offer
   "Retry reading key" when secure storage cannot be read). Earlier builds fail
   every persistence check on phones for a known reason: their storage keys
   contain `:`, which `expo-secure-store` rejects, so device identities and
   room keys are never saved. Their failure signature is an endless
   "Opening room… / Connecting securely to the conversation." screen when
   opening any existing room; if you see it, stop and check the candidate's
   build date (see `test-results/encrypted-room-recovery/ios/20260910T180851Z/`).
2. The **same build** installed on two representative iPhones and two
   representative Android phones. On each phone, open **Profile → Build
   information** and copy the non-sensitive build ID, app version, update
   creation time, runtime, and client type into the record's build column.
   Confirm the displayed build ID matches the candidate's EAS build ID, then
   record the phone model and OS version. The client type must read **Published
   build**; Expo Go and development previews are not release candidates.
3. A reachable API and database environment that holds no production data.
   Record its label (for example "development API"), never its credentials.
4. Three dedicated, verified test accounts: **A** (room creator), **B** (second
   phone), and **C** (non-participant). Record labels only, never emails or
   passwords.
5. Safe read access to the environment's database or API for the boundary
   check (ciphertext-only inspection). Do not copy payloads into evidence.

## SDK 57 Android preview handoff

The development-preview launch boundary has a separate, repeatable route. It
must use a physical Android phone running the stock Expo Go app; a browser,
Android emulator, simulator, or a published build is not a substitute.

Use either of these supported handoff options:

- **Manual phone pass:** give the operator the current public Expo preview
  link or QR code from the running Chat App workflow. The operator installs
  stock Expo Go from Google Play, records the Expo Go version and Android
  version, then opens that link in Expo Go on a fresh app launch.
- **Device farm or self-hosted Android runner:** use a farm or runner that
  provides an interactive physical Android phone and allows the operator to
  open the same public Expo preview in stock Expo Go. `adb` may collect a
  redacted screenshot or filtered device log, but an `adb` install of a
  custom build does not count as the Expo Go preview launch.

For this repository, the existing GitHub Android release jobs are not that
runner: their `self-hosted, linux, android, smallest-simulator` labels and
preflight are for a booted emulator and an installed release candidate. Use a
separate self-hosted runner or device-farm session with an interactive
physical-device capability. Before the handoff, confirm `adb devices` shows
the phone and that stock Expo Go is installed; do not report an emulator or
the release workflow's native smoke result as preview evidence.

For either option:

1. Before opening the link, record the phone model, Android version, Expo Go
   version, UTC time, and the non-secret preview host label. Do not record an
   account email, token, QR payload, or URL containing credentials.
2. Set `EXPO_DEV_REQUEST_LOG=1` in the development environment and restart the
   managed Chat App/Expo workflow before the handoff. After the workflow
   reports that Metro is ready, run:

   ```sh
   pnpm --filter @workspace/chat-app run validate:preview-startup
   ```

   This preflight checks the public Expo manifest endpoint using the managed
   `REPLIT_EXPO_DEV_DOMAIN` and then performs the local Expo Go manifest and
   bundle probe. Do not start the phone session unless the output includes
   `Public preview reachability: PASS`. A non-200 public manifest response
   means the public edge is unhealthy: restart or repair the managed workflow
   and rerun the preflight. The preflight's public-edge result is reachability
   evidence only, not native-device evidence.
3. The operator opens the fresh preview from stock Expo Go, waits for the Chat
   App landing screen, and captures a screenshot with account identifiers and
   message content cropped or blurred. Treat the launch as observed only when
   both the phone screen and
   server-side request evidence are available. A native request has no
   browser `OPTIONS` preflight; record the Android/Expo Go user-agent or
   client marker from the filtered log without retaining the full host or URL.
4. If Expo Go cannot launch, record the exact phone error and a redacted
   screenshot. A workspace `curl`, a browser tab, or a Metro startup line
   proves public reachability or workflow readiness only; the preview preflight
   is also not proof of an Expo Go session launch.
5. Append `validation-record.md` under
   `test-results/encrypted-room-recovery/android/<UTC timestamp>/`. Include
   separate rows for the public-edge reachability result and the Expo Go
   launch result, along with the device metadata and redacted evidence paths.
   When no physical route is available, write `BLOCKED` rows rather than
   inventing device values. Because the repository ignores artifact-level
   `test-results/`, force-add the completed record with `git add -f` so it is
   retained; do not create a duplicate copy under `docs/`.

The current blocked baseline is
`test-results/encrypted-room-recovery/android/20260914T144407Z/validation-record.md`.
Append a new UTC directory after a real handoff; do not overwrite the baseline.
This preview handoff is separate from the release-candidate procedure below.
Expo Go can verify the preview launch boundary, but only the same published
build installed on two phones can verify secure-storage persistence and
force-close recovery.

## How the app behaves (what "expected" means below)

- Each account/device pair owns a device keypair in secure storage. The public
  key is registered with the server before any encrypted room is joined; rooms
  stay unavailable, with automatic retries, until registration succeeds.
- Room keys are generated by the creator and delivered as encrypted envelopes.
  Only the room creator may send or persist envelopes, and only to members who
  are currently in the room. A persisted envelope is restored only for the
  account that joins.
- The room screen shows "Encryption key unavailable" until a key is present,
  and "Unable to decrypt this message." for history it cannot read. The sandbox
  shows "This device does not have the room encryption key." in the same state.
- A failed key save shows a "Retry saving key" banner; a secure-storage read
  failure shows "Saved encryption key could not be read" with "Retry reading
  key". Any appearance of either banner on a healthy phone is a failure, and
  the room screen must never stay on "Opening room…" without one of them.
- There is **no user-facing device-identity reset**. Uninstalling the app clears
  secure storage and produces a new identity; that is the only supported reset
  path today and is recorded as a limitation, not a pass.

## Procedure (repeat per platform with that platform's phones A and B)

1. **Metadata.** Fill in the record's metadata table before testing. Use
   **Profile → Build information** on each device as the source for its build
   column; do not substitute a manifest URL or other environment details.
2. **Fresh state.** Fresh-install the candidate on both phones. Sign in as A on
   phone A and B on phone B. Wait until each phone shows rooms as available
   (public key registered).
3. **Create (A).** Create a room. Expected: "Saving encryption key…" finishes,
   the room opens, and no key-storage warning appears. Send verification
   message M1 (a random token you do not record). Open the sandbox and make a
   small change S1.
4. **Join (B).** Join by room ID. Expected within 30 s: M1 is readable in
   history, a new message from A is readable live, and the sandbox shows S1.
   B sends M2; A reads it.
5. **Boundary.** Using safe read access, confirm the room's messages, sandbox
   state, and envelopes are stored as ciphertext plus nonce only. Record
   "ciphertext only: yes/no".
6. **Force-close.** On each phone independently: force-quit, relaunch, reopen
   the room while the other phone stays closed. Expected: M1/M2 decrypt from
   the locally persisted key with no peer online, no retry banner. Then send
   M3 from that phone and confirm the other phone reads M3 and still reads
   M1/M2 after relaunching. Old history becoming unreadable on either phone
   means a replacement room key was generated: FAIL.
7. **Network loss.** On phone B: enable airplane mode, force-quit, relaunch
   offline, open the room list, then disable airplane mode. Expected: key
   registration retries complete, the room becomes joinable, history decrypts,
   and no replacement key is needed. Repeat on phone A.
8. **Identity change (documented limitation).** Uninstall and reinstall on
   phone B, sign in as B. Expected: B's registered public key changes (compare
   the first and last four characters of the key shown by the profile API; do
   not record the full key). With phone A present in the room, B joins and
   receives a fresh envelope; history decrypts. Without A present, B stays at
   "Encryption key unavailable" — record that as the expected limitation.
9. **Non-participant (C).** Sign in as C on a spare session that has never
   joined the room, while A is offline. Expected: C cannot read the room's
   history (no persisted envelope exists for C and only the creator can issue
   one), and joining another room does not deliver this room's envelope.
10. **Assistant.** In the room and sandbox screens, confirm no coding-assistant
    control is available. The server-side rejection of assistant requests for
    encrypted rooms is covered by automated tests.
11. **Automated companions.** Run the existing suites and record the results:

    ```sh
    pnpm --filter @workspace/chat-app exec jest __tests__/CryptoContext.test.tsx __tests__/Room.test.tsx __tests__/secureStorageKey.test.ts --runInBand --coverage=false
    pnpm --filter @workspace/api-server exec vitest run src/socket.rooms.test.ts --maxWorkers=1
    pnpm --filter @workspace/api-server exec vitest run src/socket.assistant.test.ts src/socket.security.test.ts src/routes/profile.test.ts --maxWorkers=1
    ```

## Evidence and redaction

Store under `test-results/encrypted-room-recovery/<platform>/<UTC timestamp>/`:

- `validation-record.md` — metadata table and the pass/fail matrix, one row per
  step above, with `PASS`, `FAIL`, or `BLOCKED` plus a one-line evidence note.
- `screenshots/` — crop or blur message bodies, sandbox contents, account
  emails, and any key material before saving.
- `logs/` — device logs filtered to app lines, with tokens and URLs containing
  credentials removed.
- `automated-regression.txt` — commands and results from step 11.

When a phone cannot load the development preview at all (Expo Go reports
"There was a problem running the requested project"), set
`EXPO_DEV_REQUEST_LOG=1` in the development environment and restart the Expo
workflow: Metro then logs one line per device request (status, host, platform,
client, path) so you can see whether the phone reaches the dev server and what
it fetched. Probing the preview URL from inside the workspace is not
conclusive, because those requests bypass the public edge. In the API log a
native client is the one without `OPTIONS` preflights; browser tabs send them.

Never record: credentials, session tokens, private or public keys in full,
message or sandbox plaintext, envelope payloads, or database rows.
