---
name: Relocatable Pino bundles
description: Why bundled Pino worker paths must be normalized and checked before API startup.
---

`esbuild-plugin-pino` can embed the absolute build-time output directory when
esbuild receives an absolute `outdir`. Normalize that generated path to the
bundle directory and verify every worker and transport asset before startup.

**Why:** The build succeeds and emits the worker files, but a bundle started
from a different workspace location still asks Node for the original build
machine's `thread-stream` worker. The API then exits only after logging starts,
which makes the failure look unrelated to the build.

**How to apply:** Keep output relocation and the pre-start asset check together.
When upgrading esbuild, Pino, thread-stream, or esbuild-plugin-pino, confirm the
generated bundle has no absolute worker output path and that a missing worker
stops startup with a direct diagnostic.