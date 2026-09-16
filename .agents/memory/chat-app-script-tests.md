---
name: Chat App script tests need explicit wiring
description: node:test files under artifacts/chat-app/scripts are invisible to Jest and run only through a dedicated package script.
---

Test files placed under `artifacts/chat-app/scripts/` do not run through the Chat App's Jest command: Jest's config ignores `scripts/`, and its default test match does not include `.mjs`. A `*.test.mjs` file there passes when run by hand and silently never runs in CI or completion validation until a package script invokes it with `node --test` and the `test` script chains it (the pattern already used for the build preflight test).

**Why:** The native branding validator's unit tests sat unwired for several tasks; regression coverage that never executes gives false confidence about release-check behavior.

**How to apply:** When adding a `node:test` file under an artifact's `scripts/` directory, add a `test:<name>` package script and append it to that package's `test` chain, then confirm the case count appears in the workflow output.
