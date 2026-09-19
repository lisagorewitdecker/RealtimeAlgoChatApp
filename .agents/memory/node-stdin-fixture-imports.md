---
name: Node stdin fixture imports
description: Keep generated fixture modules importable from hosted workflow snippets executed through Node stdin.
---

Direct-execution guards in modules that are imported by `node --input-type=module` stdin snippets must check that `process.argv[1]` exists before resolving it.

**Why:** Node stdin execution has no script argument at `process.argv[1]`; calling `resolve(process.argv[1])` during import throws before exported fixture data can be read.

**How to apply:** Keep direct-run behavior behind an existence check whenever a generated fixture is imported by inline workflow validation.