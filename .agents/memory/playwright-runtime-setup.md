---
name: Playwright runtime setup
description: How browser-based diagnostics should handle Chromium dependencies in Replit test environments.
---

Declare Chromium's native runtime libraries through Replit's Nix system
dependencies and run a real browser-launch preflight before diagnostic tests.
Do not rely on Playwright's operating-system dependency installer.

**Why:** Playwright installs its pinned browser binary, but its dependency
installer invokes apt, which Replit blocks. Without a launch preflight, a
missing native library can look like a failure in the diagnostic being tested.

**How to apply:** When Playwright or its browser revision changes, keep the Nix
runtime declaration current and preserve a setup step that launches and closes
the selected browser before recovery or cleanup diagnostics execute.