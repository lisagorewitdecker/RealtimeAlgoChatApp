---
name: Chat App script tests need explicit wiring
description: node:test files under artifacts/chat-app/scripts are invisible to Jest and run only through a dedicated package script.
---

Test files placed under `artifacts/chat-app/scripts/` do not run through the Chat App's Jest command: Jest's config ignores `scripts/`, and its default test match does not include `.mjs`. A `*.test.mjs` file there passes when run by hand and silently never runs in CI or completion validation until a package script invokes it with `node --test` and the `test` script chains it (the pattern already used for the build preflight test).

**Why:** The native branding validator's unit tests sat unwired for several tasks; regression coverage that never executes gives false confidence about release-check behavior.

**How to apply:** When adding a `node:test` file under an artifact's `scripts/` directory, add a `test:<name>` package script and append it to that package's `test` chain, then confirm the case count appears in the workflow output.

Nested package commands launched from a `node:test` case must remove the inherited
`NODE_TEST_CONTEXT`; otherwise Node treats the child test runner as recursive,
skips its files, and can falsely let a validation pipeline continue.

**Why:** Node's test harness uses this context to avoid recursive test
execution, but that behavior is unsafe when a regression needs to invoke the
actual package validation pipeline.

**How to apply:** When a test invokes a package script that itself runs
`node --test`, clone the environment, delete `NODE_TEST_CONTEXT`, and strip any
test-only controls from unrelated fixture subprocesses.

The same applies to shell runs from an agent session: `NODE_TEST_CONTEXT= node --test …`
(empty assignment) still counts as "present" for Node 24, prints only the
"run() is being called recursively" warning, runs zero tests, and exits 0. Use
`env -u NODE_TEST_CONTEXT node --test …` and treat a run without an `ℹ tests N`
line as not having run at all.
