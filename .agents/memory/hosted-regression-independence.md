---
name: Hosted regression independence
description: How release validation scenarios that use controlled fixtures stay observable when protected release prerequisites fail.
---

Hosted release regression jobs that use only checked-in controlled fixtures and GitHub-hosted tooling should not depend on protected credentials or native-runner health. Keep the final release gate dependent on those prerequisites.

**Why:** A credential or self-hosted-runner failure otherwise skips the very hosted failure-mode evidence intended to diagnose release recovery behavior.

**How to apply:** Put controlled artifact/recovery checks behind only lightweight checkout and toolchain prerequisites; let the promotion gate consume their result alongside credential and native-job results.