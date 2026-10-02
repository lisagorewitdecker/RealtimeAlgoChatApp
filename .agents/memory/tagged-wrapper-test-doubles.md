---
name: Tagged wrapper test doubles
description: Why a stand-in for a wrapper component must render a marker the real replacement cannot, and how to prove the resulting containment assertions with a typecheck-clean mutant.
---

Rule: when a suite replaces a wrapper component (keyboard-aware scroll view,
provider, avoiding view) with a stand-in, the stand-in must render a tagged
host element of its own and the suite must query the wrapped content through
`within(thatHost)`. A pass-through stand-in that renders the same element type
the screen would fall back to (a plain `ScrollView` with the screen's props)
cannot tell "uses the wrapper" from "dropped the wrapper".

**Why:** the Chat App form screens pass their `testID` and
`keyboardShouldPersistTaps` themselves, so prop assertions on
`getByTestId("<screen>-scroll")` were satisfied by a plain `ScrollView`; the
compat import merely went unused (the app tsconfig does not enable
`noUnusedLocals`) and the source-level keyboard check only forbids the wrong
components. Phones would lose keyboard-aware scrolling with every check green.

**How to apply:**
- Keep the screen's own props on the inner element and put the marker on an
  outer host, so existing prop assertions keep working; share the stand-in
  from `test-utils/` instead of copying an inline `jest.mock` per suite
  (`jest.requireActual("../test-utils/<mock>")` inside the factory is the
  convention).
- Assert every step of a multi-step form (verification code, reset steps,
  join/create modes) inside the host, not just the first render.
- A rendered-tree convention ("inputs inside the wrapper") belongs in Jest;
  the AST source rules cover import/config conventions. A source rule that
  only requires both elements somewhere in the file would still pass an input
  rendered beside the wrapper.
- Prove it with a mutant that typechecks: drop controller-only props such as
  `bottomOffset` when swapping to `ScrollView`, and make sure the import
  rewrite is valid — a mutant that crashes at render fails every test and
  proves nothing about the containment assertions. Run it under both Jest
  projects (`--selectProjects iOS` / `Android` with `--` before the path).
