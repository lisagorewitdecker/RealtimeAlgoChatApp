---
name: Android preflight JSON contract
description: The review-safe policy for machine-readable Android preview handoff artifacts.
---

Machine-readable Android preview preflight artifacts are optional sidecars for
legacy Markdown-only records, but any sidecar present beside a handoff record
must satisfy the redacted four-boundary contract. Public reachability and local
probe statuses must agree with the corresponding Markdown rows; phone evidence
remains a separate boundary.

**Why:** Operators began saving the preflight as JSON before copying its values
into the review record. A malformed or edited sidecar must not become trusted
review evidence, while older records without a sidecar must remain readable.

**How to apply:** Keep the JSON validator strict about exact shape, boundary
status enums, and sensitive evidence. Report only fixed boundary-level
diagnostics; never echo parsed JSON content.

Hosted verification fixtures must include the delegated preflight validator and
use its accepted redacted evidence vocabulary; syntactically valid JSON alone
is insufficient.

**Why:** The hosted gate validates the full redacted schema, not only JSON
syntax or the Markdown record.

**How to apply:** Build probe fixtures from passing contract examples or run
the delegated validator locally before relying on a hosted check result.