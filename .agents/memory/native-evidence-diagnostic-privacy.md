---
name: Native evidence diagnostic privacy
description: Release checker failures must preserve actionable context without echoing values copied from native evidence fixtures.
---

Native evidence release diagnostics should name the failing condition and artifact path, but must not print parsed review values, review notes, candidate IDs, timestamps, platform values, parser snippets, or field names copied from fixture content. Fixed field names hard-coded by the checker are safe; parsed field names can contain control characters and must be replaced with generic structural wording. Downloaded run-directory names must be constrained before they reach logs or Markdown summaries.

**Why:** Release logs are broadly visible and evidence fixtures can contain credentials, personal data, or other untrusted text. One verbose failure path can undo the privacy guarantees of the rest of the checker.

**How to apply:** When adding a native evidence validation branch, use a fixed reason for parser failures, reject unsafe artifact path components, render summary paths and findings as sanitized code text, avoid interpolating parsed values or keys into issue/notice messages, and add a release-level assertion that useful failure context remains while fixture sentinel values and control-input names are absent.

For image-backed evidence, a binary scan can catch printable account, message,
token, and host metadata without reproducing the match, but it cannot verify
text rendered into pixels. Require a separate human redaction-review result for
screenshots and keep automated findings category-only.

**Why:** Image metadata and visible pixels are different privacy boundaries;
accepting a file solely because it has a valid image header leaves reviewers
responsible for an unrecorded safety decision.

**How to apply:** When a screenshot is part of a PASS record, validate its
printable metadata and require a dedicated PASS review row. Phone-error-only
evidence does not need a screenshot review.

Native evidence checker output must be bracketed by GitHub's stop-commands guard at the workflow boundary. Keep the checker output visible and preserve its exit status, but do not let evidence-derived text be parsed as a workflow command or annotation.

**Why:** The checker may receive uploaded evidence that is not trustworthy. A future diagnostic branch could reintroduce control sequences even if the current duplicate-field paths are generic and the job summary is sanitized.

**How to apply:** Around every direct workflow invocation of the checker, generate a cryptographically random unique stop token independently of run metadata, run the checker without a transforming pipeline, restore command parsing afterward, and exit with the captured checker status. Test both the log output and `GITHUB_STEP_SUMMARY`.

Artifact download outcomes are part of the evidence trust boundary. The final gate must pass each platform's download result into the checker so a failed or empty download is a fixed platform-specific blocking finding, its unavailable report is not linked, and a successfully downloaded platform keeps its own safe artifact link.

**Why:** A missing directory alone does not distinguish an artifact download failure from an incomplete uploaded run, and carrying an unavailable link forward can mislead reviewers about which platform evidence they can inspect.

**How to apply:** Capture `actions/download-artifact` outcomes on steps that continue after failure, pass them through the untrusted checker boundary, suppress links for non-success outcomes including an explicitly empty outcome, and test a mixed failed/successful platform case.

**JSON parsing in Node release checks (learned 2026-09-14):** V8's `JSON.parse` messages quote the input (`Unexpected token 'o', "…content…" is not valid JSON`), and when a `SyntaxError` escapes uncaught, Node prints the offending *source line* — the raw file content — before the stack trace. A release check that rethrows a raw parse error therefore copies candidate metadata (which carries bundle/package IDs) into the workflow log even when the summary is clean. Catch the parse, throw a fixed-reason error, and keep the summary's "not inspected" state distinct from "fields mismatched" so unparsed metadata is never reported as field drift. The public native label and permission copy are shown in the branding summary by design; only identifiers and parser output are excluded.
