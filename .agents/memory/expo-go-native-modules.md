---
name: Expo Go native modules and preview 502s
description: Why the Chat App preview "crashes" in Expo Go or returns 502, and how to check the web preview reliably.
---

## Native-only SDKs must be gated in Expo Go
Expo Go does not contain the native half of `@sentry/react-native` (or any config-plugin SDK). Initializing or wrapping the root
with such an SDK at startup crashes the Expo Go session while the same code works in a built binary.

**Why:** the app crashed on a phone in Expo Go right after Sentry init/wrap was added at module load.
**How to apply:** gate native SDK init on `Constants.executionEnvironment !== ExecutionEnvironment.StoreClient` and keep a Jest
case that mocks `expo-constants` as `storeClient`. Release verification for the SDK must run on EAS/native candidates, never Expo Go.

## Expo Go home screen ("run npx expo login") is a dropped launch, not a sign-in problem
Expo Go in the Preview simulator is signed into the `replit-private-<repl id>` account, which is an Expo **robot** account.
Expo's development-session API rejects robots ("Robot access to this API is not supported"), so signing the CLI into it
(via `REPLIT_EXPO_SESSION_SECRET` in `~/.expo/state.json`) changes nothing for discovery; a signed-in CLI just fails the
ping silently at debug level. The home screen appears after Expo Go abandons a launch (e.g. a 502 while the dev-server
port was blocked) and stays until the app is relaunched (simulator Restart / reopen the project).

**How to apply:** check `artifacts/chat-app/.expo/devices.json` — every Expo Go manifest fetch records the device there.
Zero devices means Expo Go never reached the server (launch/proxy problem); devices present means the app loaded and any
symptom is an app-level error, so ask for a screenshot instead of debugging the server.

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
