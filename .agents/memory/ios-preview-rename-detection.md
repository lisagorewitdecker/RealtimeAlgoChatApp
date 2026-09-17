---
name: Mobile preview rename detection
description: The mobile release gate must recognize moved timestamped validation records and keep each sidecar paired.
---

Force Git rename detection in each mobile preview diff before validating changed paths. A renamed record and its preflight sidecar should be counted once and linked at the destination path; a malformed destination must still fail the required check.

**Why:** Without an explicit rename-detection contract, a path move can be mistaken for an unrelated delete/add pair or omitted from the evidence summary, weakening the required check.

**How to apply:** Keep the diff's rename flag and rename-inclusive filter covered by the caller contract. Exercise valid and malformed renamed records, and verify the checker receives each destination record with its sibling sidecar.
