---
name: React Native heading semantics
description: Cross-platform heading levels in this Expo app
---

Use `accessibilityRole="header"` for native screen-reader heading semantics and pair it with `role="heading"` plus `"aria-level"` for web heading levels. React Native 0.81 typings do not expose `accessibilityLevel`, so passing that prop directly fails strict typecheck.

**Why:** The app runs through React Native Web and native Expo targets, while the installed React Native types omit the platform-neutral level prop. The paired semantics keep both browser accessibility trees and native accessibility services covered without an unsafe type escape.

**How to apply:** For every semantic heading, preserve the `accessibilityRole="header"` prop and add the typed spread `{ role: "heading", "aria-level": level }`; verify both props in focused tests.