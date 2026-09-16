---
name: Evidence metadata duplicate detection
description: How to reject ambiguous machine-generated key=value evidence files and keep the regression fixtures honest against the producer.
---

Detect duplicate declarations generically over every `key=value` line of a machine-generated evidence file; never maintain a list of "single-value keys" in the checker.

**Why:** A checker-side allowlist for duplicate detection was rejected in review because it silently omitted fields the producer actually writes (run_mode, app_id, device_udid, screen_px, screenshot counts). Any field the producer adds later would again be parsed first-value-wins, which is exactly the ambiguity the check exists to prevent.

**How to apply:**
- Count occurrences per key (CR-stripped, ignore empty/whitespace keys), report `has N <key> declarations`, and never print, compare, or select either value for a duplicated key — guard every value check on "declared at most once".
- For JSON objects, keep the seen-key set scoped to each object; repeated names in separate nested objects are valid, while repeated decoded names in one object are ambiguous.
- Test fixtures for evidence files must mirror the producer's full field set (see the native large-text `run.sh` writers), and the "duplicate everything" regression case should derive its expected keys from the fixture so new producer fields are covered automatically.
- The same rule applies to the remaining first/last-value readers (Sentry trigger details, candidate build files).

Related: when `pnpm test:unit` is red, run its `&&` chain step by step — a pre-existing failure early in the chain hides every later step, including the evidence suite.
