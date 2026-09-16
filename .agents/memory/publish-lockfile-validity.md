---
name: Publish lockfile validity
description: Why a clean local build can differ from a publish build when pnpm falls back from a malformed lockfile.
---
Fresh publish installs must parse the committed pnpm lockfile successfully; otherwise pnpm may resolve a different compiler or dependency version than the workspace's existing node_modules.

**Why:** A malformed lockfile caused publish to install a TypeScript behavior that rejected the project's valid TypeScript 6 configuration, while the local tree passed. The misleading compiler error was downstream of lockfile fallback.

**How to apply:**
- Run `pnpm install --lockfile-only --offline` or an equivalent lockfile parse check before diagnosing compiler-version publish failures.
- Treat any “Ignoring broken lockfile” warning as the primary failure, not as harmless install noise.
- Reproduce the artifact's full production build after repairing dependency metadata; do not remove compiler options solely to match a fallback install.
