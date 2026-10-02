---
name: Publish failure messages can be stale
description: How to handle repeated "deployment build failed" messages when the deployments service shows no new build.
---
Rule: when a "my deployment build failed" message repeats, first check whether a build newer than the last diagnosed failure exists (build list timestamps, `getDeploymentInfo().hasSuccessfulBuild`, recent deployment logs). If nothing new exists, do not re-run the same diagnosis; ask what the user sees when they click Publish now.

**Why:** On 2026-09-15 the same failure message arrived three times for one build (a Metro resolution failure that had already been fixed). No new build was ever created; the messages came from a stale failure card. The user's next Publish click succeeded without further changes.

**How to apply:** Diagnose a real failure once, fix it, verify the fix locally with the exact publish commands, then treat repeats as "confirm a new attempt happened" rather than "find another cause". Also compare the publish configuration (`.replit`, each `artifact.toml`) against the last successful build's commit before suspecting configuration drift.

**Publishing snapshots the working tree, not only commits.** A publish started while a merge had left a manifest corrupted died in its `pnpm install` step about ten seconds in, and the build log named the file and the byte offset of the parse error. That offset matched no committed revision of the file, and the commit checked out at the time parsed fine — which is the tell that the snapshot captured uncommitted damage rather than a bad commit. Such a build has nothing to fix in the code: confirm the tree is healthy now (parse every tracked manifest, parse the lockfile, run a frozen install) and have the owner publish again.
