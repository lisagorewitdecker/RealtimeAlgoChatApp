---
name: React Native Web switch checked state
description: The Chat App's switch-style toggles expose no aria-checked on web; assert their state through the accessible name in browser checks.
---

In browser (Playwright) checks of the Chat App, read a switch's state from its accessible name (`Reduce transparency: off` / `on`), not from `toBeChecked()`.

**Why:** The toggles set `accessibilityState={{ checked }}`, and react-native-web 0.21 renders that prop as no attribute at all: it only maps `aria-checked` / `accessibilityChecked`. Playwright therefore reports `unchecked` in both states, so `not.toBeChecked()` passes vacuously before a press and `toBeChecked()` never settles after it (seen 2026-09-19 while adding the reduce-transparency tab bar E2E).

**How to apply:** Locate the toggle with `getByRole("switch", { name: "<label>: off", exact: true })`, press it, then wait for the `: on` name. If the app ever adds `aria-checked` for web, `toBeChecked()` becomes valid again; until then the missing attribute is also a real screen-reader gap on web.
