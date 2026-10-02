---
name: Sentry native upload policy (pnpm + Expo Launch)
description: Non-obvious constraints behind the Chat App's conditional Sentry upload steps — pnpm CLI resolution, no soft-fail on iOS, and which build channel runs lifecycle hooks.
---

**Rules**

1. Under pnpm, `@sentry/react-native`'s native build scripts can only find
   sentry-cli when the app itself declares `@sentry/cli`, pinned to the exact
   version `@sentry/react-native` depends on. Re-pin on every Sentry upgrade.
2. Sentry's iOS build phase cannot soft-fail: without an auth token it aborts
   the Release archive, and the script ignores `SENTRY_ALLOW_FAILURE`. Any
   build channel that lacks the token must not have the upload steps in its
   generated native project at all — hence the local wrapper plugin that applies
   the official Sentry Expo plugin only when a credential is present. Never add
   `@sentry/react-native` (or `/expo`) directly to `app.json` plugins again.
3. Expo Launch (Replit's Publish pane) builds do not run the app's
   `eas-build-pre-install` hook, and never carry `SENTRY_AUTH_TOKEN`. The strict
   fail-closed preflight in that hook is therefore only the GitHub/EAS release
   gate, and must stay strict.

**Why:** The App Store archive died in the Sentry-wrapped bundle phase with a
Node "cannot find module" error (pnpm shim fallback returned an unusable path);
fixing resolution alone would have moved the failure to the unauthenticated
upload call. The archive had reached Xcode compilation, which the strict
preflight would have prevented — that is the evidence for rule 3.

**How to apply:** For a Publish-pane iOS/Android failure mentioning
`sentry-cli`, `PhaseScriptExecution`, or "Upload Debug Symbols to Sentry",
check rules 1–2 first. If such a failure ever shows the preflight's "Native
mobile release build requires…" message, Launch has started running hooks and
the two channels need an explicit, non-secret mode switch — do not loosen the
gate by default. A scratch `expo prebuild --platform ios --no-install` with and
without a placeholder token shows the policy in effect; revert the prebuild's
edits to `app.json`, `package.json`, and `.gitignore` afterwards.
