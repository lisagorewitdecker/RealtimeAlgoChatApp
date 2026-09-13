---
name: Expo Sentry wizard fallback
description: How to recognize and recover when the React Native Sentry wizard silently does nothing in a non-interactive Expo workspace.
---

Treat a zero exit code from the React Native Sentry wizard as insufficient evidence of setup: in a non-TTY monorepo it can print only its banner and produce no file changes when the Sentry connection step cannot complete.

**Why:** Repeated normal, non-interactive, and skip-connect runs all exited without generating configuration. Manual Expo setup worked, but installing the latest SDK initially selected a version outside Expo's supported range.

**How to apply:** Inspect the Git diff after every wizard run. If it is empty, configure the Expo plugin and root SDK initialization explicitly, source runtime DSNs from managed environment configuration, and install the version Expo reports as compatible. Keep source-map upload tokens in the release environment rather than source control.
