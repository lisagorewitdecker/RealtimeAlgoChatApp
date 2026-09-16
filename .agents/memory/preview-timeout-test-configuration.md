---
name: Preview timeout test configuration
description: Keep CLI preview timeout environment values compatible with the validator's numeric parsing.
---

Preview validator timeout environment variables must be passed as plain decimal strings, not JavaScript numeric-literal spellings such as `2_000`; the validator parses them with `Number()`, which rejects separators and falls back to the default timeout.

**Why:** A command-line timeout regression test appeared to hang because an invalid numeric environment value silently selected the 30-second default.

**How to apply:** When spawning the validator in tests or CI, use values such as `2000` and assert the intended short timeout is actually exercised.

For subprocess fetch stubs that distinguish public and local probes, match local requests by hostname and path rather than full origin because the fixture port is assigned dynamically.

**Why:** A full-origin match omitted the ephemeral local port, so a supposed bundle stall passed through and the CLI regression test falsely reported a successful local probe.

**How to apply:** Keep public URL matching exact for redaction coverage, and use `requestUrl.hostname === "127.0.0.1"` plus the expected path for local timeout fixtures.