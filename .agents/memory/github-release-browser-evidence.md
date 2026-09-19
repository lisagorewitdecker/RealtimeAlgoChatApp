---
name: GitHub release browser evidence
description: The release-environment gate that determines whether idle-profile browser evidence can run in GitHub Actions.
---

The idle-profile release job can finish without running Playwright when the GitHub `mobile-release` environment does not provide browser targets and its Clerk/database configuration. A green configuration step is not evidence that the browser check ran; inspect the step outcomes and artifact list.

**Why:** A controlled dispatch initially skipped the browser check and produced no artifact because the GitHub environment lacked the required targets and secrets.

**How to apply:** Before claiming browser evidence was captured, confirm the idle-profile test step failed or passed as expected, the upload step succeeded, and the named artifact contains the screenshot, trace, and error context.
