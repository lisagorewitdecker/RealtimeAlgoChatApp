---
name: Preview timeout test configuration
description: Keep CLI preview timeout environment values compatible with the validator's numeric parsing.
---

Preview validator timeout environment variables must be passed as plain decimal strings, not JavaScript numeric-literal spellings such as `2_000`; the validator parses them with `Number()`, which rejects separators and falls back to the default timeout.

**Why:** A command-line timeout regression test appeared to hang because an invalid numeric environment value silently selected the 30-second default.

**How to apply:** When spawning the validator in tests or CI, use values such as `2000` and assert the intended short timeout is actually exercised.