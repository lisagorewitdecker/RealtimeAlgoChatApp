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

For hosted native tamper regressions, create only controlled fixture values,
move them through the real artifact upload/download actions, and invoke the
existing test through the untrusted-checker wrapper. Report only fixed
platform/status outcomes; never dump the downloaded evidence or its reviewer
metadata.

**Why:** A hosted artifact path check is useful only if it preserves the same
workflow command boundary as the release gate while keeping fixture contents
out of the log.

**How to apply:** Keep the fixture run layout deterministic for the test
harness, use a temporary fixture root, and make the release gate depend on the
hosted regression result.
For hosted tamper checks, capture the entire untrusted-checker wrapper stream
before printing it, verify the wrapper's matching stop/resume markers, and scan
both that log and the reviewer summary for workflow commands and private
fixture sentinels. Keep negative assertions redacted so a failed safety check
does not print the value it was meant to protect.

**Why:** A wrapper can be present in the workflow while a later log or summary
writer still leaks a command marker or fixture metadata; failures must identify
the platform and validation deadline without reproducing the evidence.

**How to apply:** Make the tamper step retain its outcome with
`continue-on-error`, let an always-run summary step perform the scans, and
fail that step after publishing only fixed BLOCKED context.
