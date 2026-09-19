---
name: API codegen fixture test hides nested failures
description: How to find the real failure when the root unit test "root API codegen validation fails when the generated client drifts" reports a missing drift message.
---

Rule: when the api-codegen workflow contract drift test fails with "did not match /Generated API drift detected after regeneration:/", do not debug the drift checker first. The fixture runs `pnpm validate:api-codegen`, whose `check-generated` script chains every api-spec test suite before the drift check, so any failing suite in that chain short-circuits the drift message. The assertion prints only a truncated `actual` string (and nested `node --test` output arrives as the binary reporter stream), which hides the real failing test.

**Why:** On 2026-09-18 a main-session commit titled "test" spliced an old ~1,100-line copy of the hooks installer into the middle of its rollback function (inside a template literal, so it still parsed) and dropped the cleanup-failure handling. The only visible symptom was this drift test failing 19 s in; the real failure was a hook-rollback test three suites deeper. Restoring the installer from the commit's parent fixed everything.

**How to apply:** Rebuild the fixture by hand (copy `git ls-files --cached --others --exclude-standard` into a temp dir, symlink root and lib package `node_modules`, append a comment to the generated client) and run `pnpm validate:api-codegen` there with `NODE_TEST_CONTEXT` removed from the env to get readable output; the last `✖` names the real suite. Then `git log -- <file>` on the implicated script and check whether the newest commit was an accidental main-session commit (huge insertion count, generic message) before treating the test as stale.
