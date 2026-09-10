---
name: Version-pinned packageExtensions go stale after upgrades
description: Why a Chat App publish failed with a missing @babel/generator after the Expo SDK upgrade, and what to check when upgrading.
---
`pnpm-workspace.yaml` `packageExtensions` keyed to an exact version
(`react-native-worklets@0.5.1`) stop applying the moment an upgrade installs a
different version, and nothing warns about it.

**Why:** The Expo SDK 57 upgrade moved `react-native-worklets` to 0.10.x. Its
Babel plugin still needed `@babel/generator`, but the extension that had been
supplying that peer no longer matched, so the publish build's Metro export
failed with `Cannot find module '@babel/generator'` while every dev workflow
kept working from the previously installed tree. The durable fix was adding
`@babel/generator` as a root dependency rather than re-pinning the extension.

**How to apply:**
- After any dependency upgrade, grep `pnpm-workspace.yaml` for `@<version>`
  extension keys and confirm each still matches the installed version.
- Prefer root dependencies or version-range keys over exact pins for peers
  that Metro/Babel plugins resolve at build time.
- The publish build runs a fresh `pnpm install` plus each artifact's `build`
  script; a stale local `node_modules` can hide the failure, so run the Chat
  App `build` script locally to reproduce publish-time bundling errors.
