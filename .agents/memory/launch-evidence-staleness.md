---
name: Launch-evidence staleness in the preview preflight
description: How the preview-startup preflight decides whether an Expo Go launch-evidence probe result belongs to the current dev server, and why its own dev server must run in pass-through mode.
---

# Launch-evidence staleness in the preview preflight

**Rule:** a probe result counts as current only when its `decidedAt` is at or
after the start record the launcher writes on every managed (non-pass-through)
dev server start. No start record means STALE, never "current by default".

**Why:** the probe result file survives Metro restarts, so without a recorded
start a reviewer cannot tell a fresh verdict from one left over from an older
dev server; the record was previously copied by hand and staleness went
unnoticed. Failing closed (STALE) keeps the preflight passing while making the
launch row BLOCKED instead of PASS.

**How to apply:**
- The preflight spawns its own throwaway dev server through the same `dev`
  script. That start must set the launcher's pass-through environment flag
  (override any inherited value) so it neither consumes an armed marker meant
  for the managed workflow nor rewrites the start/result records. Test
  harnesses strip that flag from the inherited base environment.
- Only a current `BUNDLE_ONLY_THEN_CLOSED` fails the preflight; NOT_RUN,
  STALE, NO_DEVICE, and INCONCLUSIVE only appear in the record.
- Copy counts-only fields into the boundary evidence; never the probe's
  `reason=` text. Malformed result/start files fail before Metro spawns with
  fixed messages that never echo file contents.
- The release evidence-reader inventory attributes a helper's `JSON.parse`
  to every entry script that imports it; an entry reaching several parsed
  arguments lists one contract per argument (array form), and the helper's
  standalone inventory entry disappears once it stops being an entry.
- The validated age format is `\d+s|\d+m \d+s|\d+h \d+m|\d+d \d+h`; do not
  add words or other units without updating the record validator's pattern.
