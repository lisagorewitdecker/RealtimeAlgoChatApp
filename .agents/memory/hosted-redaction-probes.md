---
name: Hosted redaction probes
description: How to run hostile metadata probes in GitHub Actions without leaking the probe values into the hosted log.
---

GitHub Actions prints step-level `env` values and the rendered shell script in
job logs. For hosted redaction verification, do not place hostile probe strings
directly in `env:` or the run script. Assemble them from encoded literals at
runtime, capture checker stdout, stderr, and the temporary summary separately,
assert the raw probes and shell-marker path are absent, then print only the
captured safe streams.

**Why:** A passing checker assertion is not enough if Actions itself echoes the
test payload before the checker runs; that would make the hosted evidence look
like a redaction failure even when checker output is safe.

**How to apply:** Use a disposable verification ref and an extra hosted step.
Scan the downloaded job log for the raw probe values, require paired
`stop-commands` markers and fixed release-blocking context, then delete the ref
after capturing the run.