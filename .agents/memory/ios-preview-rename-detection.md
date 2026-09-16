---
name: iOS preview rename detection
description: The mobile release gate must recognize moved timestamped iOS validation records as one changed record.
---

Force Git rename detection in the iOS preview diff before validating changed paths. A renamed record should be counted once and linked at its destination path; a malformed destination must still fail the required check.

**Why:** Without an explicit rename-detection contract, a path move can be mistaken for an unrelated delete/add pair or omitted from the evidence summary, weakening the required check.

**How to apply:** Keep the diff's rename flag and rename-inclusive filter covered by the caller contract. Exercise valid physical-phone BLOCKED, public-edge FAIL, and malformed renamed records in the summary fixture.