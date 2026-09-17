---
name: Chat App source-rule checks
description: How to guard runtime conventions that Jest cannot observe because the relevant dependency is mocked.
---

When a runtime convention is invisible to tests because the relevant dependency is mocked, enforce it with a small AST-based source rule in the package that owns the convention. Prefer statically provable invariants over regex heuristics, and report the file, rule, and corrective strategy.

**Why:** Mocked modules can make an incorrect import or configuration pass every runtime-oriented test. Parsing the source preserves the convention at the boundary where it is declared without pretending to execute arbitrary helpers.

**How to apply:** Keep the check fast and run it before slower tests. Cover aliases, namespace access, comments, and representative indirection in fixtures; scan the real source tree too. Update the written strategy note and source rule together when the convention changes.
