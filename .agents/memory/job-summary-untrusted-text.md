---
name: Job summary untrusted text
description: How reviewer-facing GitHub job summaries render text that originates from pull request descriptions or generated findings.
---

Render any text that comes from a pull request body (breaking-change justifications, and any future markers such as migration plans) as Markdown code when writing to `GITHUB_STEP_SUMMARY`. Use code spans for single-line text and nested fenced code blocks for multi-line text so line breaks remain visible. Pick a backtick fence longer than the longest backtick run in the text so the content stays verbatim.

**Why:** The step summary is the reviewer's decision record. PR descriptions are author-controlled, so rendering them as raw Markdown would let a description inject links, images, or headings into the summary, and Markdown-significant characters in findings (`_`, `*`, `<reason>`) would render differently from the console output reviewers compare against.

**How to apply:** Any new job-summary section that echoes PR-body text or contract findings should reuse the code-span/code-block approach rather than blockquotes or raw interpolation. Nest multi-line blocks beneath their declaration list item so authors' bullets stay literal and the label association remains clear. Keep the summary shape consistent with the existing `## Title` / `- Status: **STATE**` / `### Section` convention used by the release preflight scripts.
