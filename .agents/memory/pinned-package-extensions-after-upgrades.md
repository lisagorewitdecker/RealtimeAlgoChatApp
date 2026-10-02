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
  extension keys and confirm each still matches the installed version. The
  worklets key is a `0.10.x` range since 2026-09-19 (the Expo Go pin moved the
  package to 0.10.0, which also does not declare `@babel/generator`); keep it a
  range, and remember that any extension edit changes the lockfile's
  `packageExtensionsChecksum`, so a frozen install fails until the lockfile is
  regenerated.
- Prefer root dependencies or version-range keys over exact pins for peers
  that Metro/Babel plugins resolve at build time.
- The publish build runs a fresh `pnpm install` plus each artifact's `build`
  script; a stale local `node_modules` can hide the failure, so run the Chat
  App `build` script locally to reproduce publish-time bundling errors.
- This workspace's pnpm install has no `.pnpm/node_modules` hoisted store, so
  a dynamically required, undeclared module (worklets → `@babel/generator`)
  resolves only through a package-extension link inside the package's store
  directory or a root dependency. Both are in place now (confirmed 2026-09-14);
  either alone is sufficient. Quick check without a full export: from
  `artifacts/chat-app`, `require("react-native-worklets/plugin")` and resolve
  `@babel/generator` with the plugin directory as the search path.
- The local export writes under `artifacts/chat-app/static-build/`, which is
  gitignored as a whole, so reproducing the publish build never dirties the tree.
