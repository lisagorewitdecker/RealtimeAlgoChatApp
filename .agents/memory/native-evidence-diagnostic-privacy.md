---
name: Native evidence diagnostic privacy
description: Release checker failures must preserve actionable context without echoing values copied from native evidence fixtures.
---

Native evidence release diagnostics should name the failing condition and artifact path, but must not print parsed review values, review notes, candidate IDs, timestamps, platform values, parser snippets, or field names copied from fixture content. Fixed field names hard-coded by the checker are safe; parsed field names can contain control characters and must be replaced with generic structural wording. Downloaded run-directory names must be constrained before they reach logs or Markdown summaries.

**Why:** Release logs are broadly visible and evidence fixtures can contain credentials, personal data, or other untrusted text. One verbose failure path can undo the privacy guarantees of the rest of the checker.

**How to apply:** When adding a native evidence validation branch, use a fixed reason for parser failures, reject unsafe artifact path components, render summary paths and findings as sanitized code text, avoid interpolating parsed values or keys into issue/notice messages, and add a release-level assertion that useful failure context remains while fixture sentinel values and control-input names are absent.