---
name: setup-node semver contract
description: The mobile release Node-range guard and local contract test must use the same semver behavior as the pinned setup-node action.
---

The mobile release workflow resolves `package.json` `engines.node` and controlled range fixtures through `actions/setup-node`. Its pinned action delegates manifest matching to `@actions/tool-cache`, whose semver implementation is 6.3.1. Keep the root semver dependency pinned to that exact matcher version and keep the contract test checking the resolved package version.

**Why:** A newer local semver implementation can normalize or accept ranges differently from the GitHub action, allowing local release diagnostics to pass while the hosted guard rejects the same range.

**How to apply:** When upgrading the pinned setup-node action, inspect its bundled tool-cache semver version and update the root dependency, lockfile, and compatibility assertion together before accepting new `engines.node` syntax.