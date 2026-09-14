---
name: Native evidence diagnostic privacy
description: Release checker failures must preserve actionable context without echoing values copied from native evidence fixtures.
---

Native evidence release diagnostics should name the failing field, condition, and artifact path, but must not print parsed review values, review notes, candidate IDs, timestamps, platform values, or parser snippets copied from fixture content. Fixed validation reasons and structural field names are safe ways to retain useful context.

**Why:** Release logs are broadly visible and evidence fixtures can contain credentials, personal data, or other untrusted text. One verbose failure path can undo the privacy guarantees of the rest of the checker.

**How to apply:** When adding a native evidence validation branch, use a fixed reason for parser failures, avoid interpolating parsed values into issue/notice messages, and add a release-level assertion that useful failure context remains while fixture sentinel values are absent.