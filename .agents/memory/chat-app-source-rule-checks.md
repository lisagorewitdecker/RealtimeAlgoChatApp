---
name: Chat App source-rule checks
description: How to guard runtime conventions that Jest cannot observe because the relevant dependency is mocked.
---

When a runtime convention is invisible to tests because the relevant dependency is mocked, enforce it with a small AST-based source rule in the package that owns the convention. Prefer statically provable invariants over regex heuristics, and report the file, rule, and corrective strategy.

**Why:** Mocked modules can make an incorrect import or configuration pass every runtime-oriented test. Parsing the source preserves the convention at the boundary where it is declared without pretending to execute arbitrary helpers.

**How to apply:** Keep the check fast and run it before slower tests. Cover aliases, namespace access, comments, and representative indirection in fixtures; scan the real source tree too. Update the written strategy note and source rule together when the convention changes.

## Cross-file indirection: follow one hop, reject the rest

When a rule can be bypassed by moving the offending expression into another file (a hook, a re-export module), follow local imports exactly one hop for a precise report, and report anything the check cannot resolve (second hop, `export *`, missing module, whole namespace) as a violation in its own right rather than accepting it. Package imports are never followed. The "correct value" (`behavior="padding"`) still has to be provable at the call site; import following exists to name the hidden split, not to accept values defined elsewhere.

**Why:** A same-file-only rule was documented as bypassable by a shared hook; a full module graph walk would turn a sub-second pre-test check into a bundler. Rejecting the unresolvable keeps the rule un-bypassable without that cost.

**How to apply:** Give followed modules a context without a resolver (that is what bounds the depth), scope visited-keys per file, and skip declaration-name identifiers when walking a followed declaration or the function reports itself twice. Also scan every directory a helper could move into; absent optional directories are skipped, the core ones stay required.
