---
name: Expo preview DevTools GTK runtime
description: The SDK 57 Expo CLI launches an optional React Native DevTools binary during preview startup.
---

The Expo preview environment must include the complete native runtime set used by SDK 57's React Native DevTools binary, including `gtk3`, `nspr`, `nss`, and the supporting GLib/GTK/X11 libraries. Without one of these libraries, Metro can still start while emitting a misleading DevTools loader error.

**Why:** Preview diagnostics are harder to interpret when an optional desktop tool reports a missing library even though the mobile Expo Go path is healthy.

**How to apply:** Keep the full runtime package set in the project’s Nix package list when upgrading Expo or React Native. Before startup, confirm installed Expo CLI/React Native versions still match captured loader evidence; then verify a fresh Expo workflow reaches Metro without any shared-library or DevTools startup error.
