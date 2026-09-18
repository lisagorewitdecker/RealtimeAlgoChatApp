---
name: Expo Go native modules and preview 502s
description: Why the Chat App preview "crashes" in Expo Go, returns 502, or never launches on iOS (Expo Go 57 dev-server sign-in), and how to check the web preview reliably.
---

## Native-only SDKs must be gated in Expo Go
Expo Go does not contain the native half of `@sentry/react-native` (or any config-plugin SDK). Initializing or wrapping the root
with such an SDK at startup crashes the Expo Go session while the same code works in a built binary.

**Why:** the app crashed on a phone in Expo Go right after Sentry init/wrap was added at module load.
**How to apply:** gate native SDK init on `Constants.executionEnvironment !== ExecutionEnvironment.StoreClient` and keep a Jest
case that mocks `expo-constants` as `storeClient`. Release verification for the SDK must run on EAS/native candidates, never Expo Go.

## Expo Go 57 on iOS requires a dev server signed into the repl's Expo account
Expo Go 57 (iOS, including Replit's iPhone simulator preview) only loads a project whose dev server is signed into the same
Expo account Expo Go uses — the repl's private `replit-private-<repl id>` account. An earlier note here claimed CLI sign-in
"does not help" because that account is a robot rejected by Expo's development-session API; that concerned SDK 54 dev-session
discovery and is obsolete (as of 2026-09-15 the account also reports type `person`). The Chat App `dev` script runs a guarded
`create-launch login --session "$REPLIT_EXPO_SESSION_SECRET"` before `expo start` (skip when unset, `|| true` on failure),
which is exactly the SDK 57 upgrade step from the Replit `upgrading-expo` skill — plus a `mkdir -p` of the Expo home
directory first, because `create-launch` 0.3.6 writes `~/.expo/state.json` atomically (temp file + rename) without creating
`~/.expo`, and a freshly booted container has no `~/.expo` until Metro creates it. Without the `mkdir`, a valid session
logs in server-side and then dies on `ENOENT … state.json<hex>`; the guard swallows it, so the only symptoms are a missing
`Logged in as …` line and an anonymous manifest on every fresh boot (a bogus session never reaches the write, so tests with a
sentinel session cannot reproduce the ENOENT — assert the directory exists instead).

**Why:** with the login step missing, the simulator sat on the iOS home screen and no Expo Go request ever reached Metro
even though the manifest and bundle were served correctly; the ENOENT variant was found on 2026-09-17 when the first
container restart after wiring the login silently came back anonymous.
**How to apply:** the signed-in identity surfaces in the served manifest as `extra.expoGo.username` (Expo CLI: "used by
Expo Go to verify account match"), not in `extra.scopeKey` — the scope key stays `@anonymous/…` without an EAS project, so
never key a sign-in check on it. Diagnostic order: manifest with no `extra.expoGo.username` = the sign-in step is missing or
failed (look for `Logged in as …` in the workflow log, restart the Expo workflow); the preview-startup validator fails on an
anonymous manifest whenever the session secret is set. `artifacts/chat-app/.expo/devices.json` is NOT evidence: Expo Go 57 iOS
sends no `expo-dev-client-id`, so it stays empty even when the app is downloaded. Whether Expo Go reached Metro and ran the
bundle is only visible in the dev server's own output (see [Expo inspector observability](expo-inspector-observability.md));
the Chat App ships a one-shot launch-evidence probe for that, and the simulator's Expo Go re-fetches the bundle after every
Metro restart, so the probe needs no user action.

**Startup-crash signature (sign-in already fixed):** manifest accepted → bundle 200 → inspector connection closed with an
abnormal code (1006) a few seconds later, no `iOS LOG`, asset, lazy-bundle, or API request, simulator back on the iOS home
screen. That is Expo Go quitting while starting the app, not a sign-in or launch-routing problem — do not spend more time on
the login step for that symptom.

## Native secure storage failures never show up in the web preview
`expo-secure-store` accepts only `[\w.-]` key names while web localStorage accepts anything, so a storage-key bug reaches
users as "Room key could not be saved" plus a fresh device identity on every launch — on phones only, with the web preview
and any permissive test mock staying green.

**How to apply:** keep the Jest SecureStore mock rejecting invalid key names, and treat "works on web, fails on iPhone" storage
reports as a key-name or native-module problem before suspecting the server.

## Duplicate Expo dev servers cause preview 502
A restarted Expo workflow can leave an orphan `expo start` holding `$PORT`. The new managed process then blocks on the
interactive "Use port N+1 instead? (Y/n)" prompt and never serves, so the preview proxy answers 502 while logs look "RUNNING".

**How to apply:** before restarting, `ps` for `expo start --localhost --port <PORT>`; kill orphans, then restart once. A log line
`Port X is running this app in another window` is the tell.

## API exits with code 137 under parallel validation
The API server has been OOM-killed (exit 137) while heavy Jest/browser workflows ran concurrently; the preview then looks broken
even though Expo is fine. Restart the API and run heavy checks sequentially (see validation-workflow-concurrency.md).

## Screenshot tool shows blank white for the Expo web preview
The built-in screenshot captures before `ClerkLoaded` renders, giving an all-white image with no errors logged. To verify the
web preview, drive Playwright from the workspace store path (`node_modules/.pnpm/playwright@*/node_modules/playwright/index.mjs`),
wait for `networkidle` plus a few seconds, and read `document.body.innerText`.
