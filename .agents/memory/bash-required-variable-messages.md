---
name: Bash required-variable messages
description: A parsing trap in Bash parameter-expansion error messages.
---

Avoid apostrophes inside the message portion of `${name:?message}`, even when
the whole expansion appears inside double quotes.

**Why:** Bash can treat the apostrophe as the start of an unmatched single
quote, reporting a misleading syntax error much later in the script.

**How to apply:** Use equivalent wording without apostrophes for required
environment-variable checks in shell scripts.