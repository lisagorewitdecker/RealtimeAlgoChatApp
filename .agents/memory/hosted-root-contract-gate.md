---
name: Hosted root contract gate environment
description: Differences between GitHub's ubuntu-latest runner and the workspace that affected the Root contract checks pull-request gate, and how to debug a red run.
---

The `Root contract checks` workflow runs the root install/typecheck/unit/codegen
set on `ubuntu-latest`; the workspace toolchain is not identical, and the
differences below each caused or nearly caused a red run.

- **ImageMagick and Tesseract are not preinstalled** on GitHub's Ubuntu 24.04
  image; the Android preview evidence test draws fixtures with them. The
  workflow installs `imagemagick tesseract-ocr tesseract-ocr-eng
  fonts-dejavu-core` with apt, and Ubuntu packages ImageMagick 6 (`convert`,
  no `magick`), so the test defines a `magick` → `convert` fallback. When
  proving that fallback locally by hiding `magick` from `PATH`, keep
  `strings` reachable — the directory that provides `magick` also provides
  binutils, and its absence fails the metadata check instead.
- **`node-version: 24` resolves to the newest 24.x** (24.20.0 on 2026-09-19;
  the workspace had 24.13.0). Under 24.20 the generated-client checker's
  cancellation tests raced signal delivery: one `setTimeout(0)` tick after
  `process.kill(process.pid, "SIGTERM")` is not always enough because the
  kernel may deliver the signal to another thread and libuv reports it only
  when the loop polls. Injected test signals now wait until the handler
  records them; a real interrupt keeps the single yield. To reproduce a
  version-specific failure locally, the official Node tarball from
  nodejs.org runs in this container (`/lib64/ld-linux-x86-64.so.2` exists).
- **Debugging a red run:** the GitHub connection cannot download job logs;
  `curl -L -H "Authorization: Bearer $GITHUB_WORKFLOW_PUSH_TOKEN"
  .../actions/jobs/{id}/logs` works, as does `POST
  .../actions/runs/{id}/rerun-failed-jobs` to tell a flake from a
  deterministic failure. `head_sha` filters on `/actions/runs` need the full
  40-character SHA; a short SHA silently matches nothing.
- **`pnpm test:unit` is an `&&` chain**, so a red unit step reports only the
  first failing command; fix it and expect later commands to surface next.

**Why:** the first hosted run of the gate was red on a clean tree for a
timing reason that never reproduced under the workspace Node, and the apt
tooling gap would have failed the Android evidence test outright.

**How to apply:** when a gate run fails on a change that passes locally, check
the runner's Node version and system tools before suspecting the change, and
rerun the failed job once to detect a flake before editing anything.
