# RealtimeAlgoChatApp Studio

RealtimeAlgoChatApp Studio is a real-time collaboration platform for developers with Build, Call, and Ship modes in a single room.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm validate:api-compatibility` — fail on breaking OpenAPI changes vs. the target branch; CI rejects an intentional breaking-change override unless the pull request description follows the canonical instructions below
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `SENTRY_DSN` — enables production error tracking and the `/api/healthz` uptime monitor in `artifacts/api-server` (see Gotchas)

### API compatibility override instructions

For an intentional versioned break, add both declarations to the pull request description.

**Inline example**
```text
API_BREAKING_CHANGE_JUSTIFICATION: <why the existing contract must break>
API_BREAKING_CHANGE_MIGRATION_PLAN: <how existing consumers move to the new contract>
```

**Multi-step migration plan example**
```text
API_BREAKING_CHANGE_MIGRATION_PLAN:
  - Release the updated client first.
  - Keep the old API available during migration.
  - Remove the old API after adoption is confirmed.
```
End the block with a blank line or the next `API_BREAKING_CHANGE_*` marker.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Production error monitoring (Sentry) is wired into `artifacts/api-server` but needs `SENTRY_DSN` set to activate — without it, the server logs a warning and runs with no error reporting or uptime alerting. It captures uncaught exceptions/rejections, Express request errors, and reports a heartbeat check-in on `/api/healthz` every 5 min (Sentry Crons "missed check-in" = the server is down). Confirm in Sentry's dashboard that the `api-server-healthz` Cron Monitor and the project's issue alert rule actually have notifications turned on — that's dashboard-only config not settable from code.
- Expo Go (Preview panel simulator or a phone) showing its home screen with "signed in as replit-private-… / run npx expo login" means the app launch was dropped (typically after a dev-server error such as a 502); relaunch it with Restart in the simulator toolbar or by reopening the project. Signing the Expo CLI into that `replit-private-…` account does not help: it is an Expo robot account and Expo rejects development-session publishing for robots, so the app is never discovered through the account. Expo Go never runs native Sentry; that is only exercised in EAS builds.
- Native secure storage (`expo-secure-store`) only accepts key names matching `[A-Za-z0-9._-]`; every keychain/keystore key must go through `artifacts/chat-app/lib/secureStorageKey.ts`, and the Jest mock in `__tests__/CryptoContext.test.tsx` enforces the same rule. Web (localStorage) accepts anything, so a native-only storage failure will not show up in the web preview.
- The registered validation commands (typecheck, API/Chat App tests, banned-room E2E, mockup typecheck) are prefixed with `flock -w 900 /tmp/replit-heavy-validation.lock` on purpose: task-completion validation launches all of them at once, and on this 4-CPU workspace that slows `tsc` ~8x and trips fixed per-test timeouts that pass when the suites run one at a time. Keep the prefix when editing those commands.
- Native crash reporting for the Chat App (`artifacts/chat-app/lib/sentry.ts`, `.github/workflows/mobile-release.yml`) is wired and gated, but the end-to-end proof from signed iOS/Android builds has not been run yet: it needs `SENTRY_AUTH_TOKEN` in the GitHub `mobile-release` environment and EAS secrets (never in the repo or Replit Secrets) plus one release-workflow run; see project task "Confirm crash reports from real iPhone and Android builds show readable code locations". The blockers were audited on 2026-09-14 (`artifacts/chat-app/docs/sentry-native-source-map-check-20260914.md`): the Chat App has no EAS project yet (`eas.json`, `ios.bundleIdentifier`, `android.package`, project ID all missing), GitHub has no `mobile-release` environment, secrets, variables, runners, or workflow runs, and GitHub `development` predates the Sentry pipeline. `@sentry/react-native` 7.11.0 already matches Expo SDK 57's bundled range, so no version alignment is pending.
- Socket.IO auth-failure/disconnect-rate Sentry alerts (`artifacts/api-server/src/lib/socketMonitoring.ts`) ship with conservative default thresholds because the app has no real production traffic yet to baseline against. Once real usage exists, retune without a code change via optional env vars: `SOCKET_AUTH_FAILURE_ALERT_THRESHOLD`/`_WINDOW_MS`/`_COOLDOWN_MS` and `SOCKET_DISCONNECT_ALERT_THRESHOLD`/`_WINDOW_MS`/`_COOLDOWN_MS` (all default if unset or invalid).
- Clerk retries for server account-access lookups (`artifacts/api-server/src/lib/accountAccess.ts`) and the Playwright browser checks (`artifacts/api-server/e2e/clerk-retry.ts`) share one policy in `artifacts/api-server/src/lib/clerkRetry.ts`: a wait between attempts never exceeds `MAX_CLERK_RETRY_DELAY_MS` (30 s), whether it comes from Clerk's `retryAfter` guidance (seconds) or the exponential fallback. Larger upstream hints are clamped, not rejected; malformed guidance falls back to the exponential delay. A server lookup additionally has a hard wall-clock deadline, `ACCOUNT_ACCESS_RETRY_BUDGET_MS` (15 s), covering waits and Clerk requests alike: it keeps the usual four attempts and delays while they fit, gives up as soon as the next wait would end past the deadline (so a capped 30 s hint is never waited out server-side), and races every Clerk request against the time left because the Clerk SDK exposes no abort signal (a hung request fails at the deadline with `AccountAccessDeadlineError` as the cause and its late result is discarded). The deadline exists because Socket.IO closes a handshake that has not finished within its 45 s connect timeout and proxies time out HTTP requests. When it gives up, `getAccountAccess` rejects with `AccountAccessUnavailableError` (`artifacts/api-server/src/lib/accountAccessUnavailable.ts`) carrying Clerk's capped guidance for the next attempt; `requireAuthorizedUser` turns that into a 503 with a `Retry-After` header and `{ code: "ACCOUNT_ACCESS_UNAVAILABLE", retryAfterSeconds }`, and the socket handshake rejects with the same message plus `connect_error` `data: { code, retryAfterSeconds }` for both the Clerk-token and room-capability branches. The Chat App and the call/sandbox WebView pages do not act on the hint yet; they still show a generic connection error.
- The Chat App is always dark (both palettes in `artifacts/chat-app/constants/colors.ts` are identical), so `app.json` pins `userInterfaceStyle: "dark"` and the root layout renders one `<StatusBar style="light" />`; Android draws its edge-to-edge status/navigation bars in the device theme otherwise and they vanish over the dark UI. Keyboard handling on native has one strategy: forms use `KeyboardAwareScrollViewCompat`, everything else uses `KeyboardAvoidingView` from `react-native-keyboard-controller` with `behavior="padding"` on both platforms (React Native's own `KeyboardAvoidingView` does not react on Android once the keyboard-controller provider owns the insets). Screens that scroll under the classic tab bar reserve its measured height through `hooks/useTabBarContentInset.ts`, which reads expo-router's vendored `BottomTabBarHeightContext` (`expo-router/js-tabs`) — do not add `@react-navigation/bottom-tabs`, a second copy of the context never receives the height. Multiline inputs set `textAlignVertical: "top"` because Android centers multiline text. No Android emulator is reachable from this workspace; Android-only appearance has to be confirmed by the user. The only early signal is `artifacts/chat-app/jest.config.js`: it runs the whole suite as the `iOS` project (jest-expo's default preset, where `Platform.OS` is `"ios"`) and the screen/layout suites listed in `androidLayoutSuites` a second time as the `Android` project (`jest-expo/android`, guarded by `jest.setup-android.js`). Add a new layout suite to that list; key expectations that legitimately differ by platform with `test-utils/platform.ts` (`onTestPlatform({ ios, android })`) rather than skipping; run one platform with `pnpm exec jest --selectProjects Android`.
- `@clerk/expo` must stay in the `plugins` array of `artifacts/chat-app/app.json` (currently with `appleSignIn: false` because the app offers no Sign in with Apple button). Its config plugin raises the iOS deployment target to 17.0, which the Clerk native module (`ClerkExpo` pod, Swift package `clerk-ios`) requires; on the SDK default (16.4) Expo autolinking skips the pod after its podspec has already registered the Swift package, and the App Store build dies in `pod install` with `undefined method 'package_product_dependencies' for nil` from React Native's SPM post-install hook. The plugin's Android edits (packaging excludes, Kotlin flag, hosted-auth intent filter) are Clerk's documented defaults. Keep the config static (`app.json`, no `app.config.*`).
- GitHub masks a secret in logs and step summaries only for the exact value registered in the same job, so release IDs and smoke-account values must stay out of summaries by construction. `scripts/tests/mobile-release-summary-contract.test.mjs` (part of `pnpm test:unit`) discovers every script the mobile release workflow invokes (directly or through package scripts) that writes `GITHUB_STEP_SUMMARY`, requires each to be listed in its `scriptContracts` inventory, and fails if the workflow, the native large-text gate, or the Android preflight interpolates a secret-backed variable into a summary, a diagnostic, or a log. Candidate IDs belong only in uploaded evidence files under the results directory; a file the workflow copies into the summary (the `native-branding-summary.md` fragment) counts as a summary and must stay identifier-free, while the detailed `native-branding-check.md` report keeps the ID; summary steps may reference step outcomes and non-secret env, nothing else; diagnostics may interpolate only allowlisted runtime values and literal script constants.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
