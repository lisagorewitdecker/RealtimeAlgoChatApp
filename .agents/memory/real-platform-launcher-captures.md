---
name: Real-platform launcher captures
description: Cross-platform hosted Expo launcher capture requirements for Windows and macOS.
---

Real Windows launcher checks must normalize direct-module entrypoint comparisons, invoke `.cmd` package launchers through a Windows shell, terminate the entire wrapper process tree, and redact both user paths and hosted workspace roots such as `D:\a`.

**Why:** Windows path formatting differs between `file:///` URLs, backslash process arguments, and GitHub runner workspace paths. Without these boundaries, the validator can exit without running, hang after Metro starts, or upload a readable but private workspace path.

**How to apply:** Keep Windows fixture tests launcher-only so they do not depend on a public preview URL. Revalidate the uploaded capture and scan it for credentials plus Unix user paths and Windows `Users`, `home`, and `a` roots.