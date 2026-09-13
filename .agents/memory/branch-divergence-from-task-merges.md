---
name: Task merges land on the checked-out branch
description: Why development/production diverge, how to reunify them, and which refs to never use when doing so.
---
Platform task merges are committed onto whichever branch is checked out in the
workspace at merge time. If the user switches branches between merges, the
branches diverge even though every merge was approved.

**Why:** In one session, seven task merges landed on `production` while three
earlier ones sat on `development`; each branch was missing work the other had,
and a publish from `production` failed until the two were reunified.

**How to apply:**
- Before validating or publishing, compare the branches (`git log --oneline
  development ^production` and the reverse). Merge the lagging branch into the
  checked-out one with `--no-ff`, then fast-forward the other
  (`git branch -f <other> HEAD`) so future merges land on one line.
- When resolving conflicts, check whether one side already contains the other
  side's blob in its history (`git log <branch> --find-object=<blob> -- <file>`);
  if so, the evolved side is safe to take wholesale.
- Never use `origin/*` refs in this workspace. `origin` is a stale gitsafe
  backup mirror, not the real branches; checking one out once made the platform
  remove the Chat App artifact and every workflow until the local branch was
  restored.
- Guard `cd` in chained shell commands (`cd dir || exit 1`). The container
  restarts under memory pressure and wipes `/tmp`, so a chained command whose
  `cd` fails falls through into the workspace checkout.
