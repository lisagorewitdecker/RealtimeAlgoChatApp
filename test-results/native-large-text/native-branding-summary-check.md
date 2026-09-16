# Native branding summary — release-summary review check

**Status:** Partially confirmed. Local contract tests confirm the summary
structure and secret boundary. A representative hosted release-gate run is
still required before this task can be completed.

## Confirmed locally

- The release workflow uploads each platform's native evidence before writing
  its branding section.
- The iOS and Android summary steps replace the detailed-report placeholder
  with the corresponding `actions/upload-artifact` URL.
- A missing generated summary still produces an explicit `FAIL` section with
  an `UNAVAILABLE` native label and permission result.
- Generated pass and mismatch summaries include the native label, the iOS
  permission-copy or Android permission-declarations result, and a link to
  `native-branding-check.md`.
- Forced-mismatch unit coverage checks that the failed field appears in the
  summary and that the detailed-report link remains present.
- `pnpm test:unit --run` passes after the latest rebase.

## Candidate ID security contract

The candidate build ID is deliberately not passed to or rendered in
`GITHUB_STEP_SUMMARY`. The summary says that it is recorded in the uploaded
evidence artifact. This supersedes the original expectation that the hosted
summary would show a masked build ID or derived fingerprint: job summaries are
visible more broadly than the downloaded release evidence, and the current
contract test prevents secret values from reaching summary-writing steps.

## Hosted confirmation still required

As of 2026-09-12, GitHub exposes the **Mobile release accessibility gate**
workflow on `production`, but it has zero workflow runs. The public hosted
workflow copy also predates the local summary steps: its raw file contains no
`native-branding-summary.md` or `artifact-url` wiring. The prepared self-hosted
macOS and Linux native runners are not reachable from this workspace, so
dispatching the hosted workflow would not produce representative evidence and
would not validate the requested behavior.

On the first representative release-gate run, an authorized reviewer must
confirm:

1. The iOS and Android jobs each show their native-branding section.
2. Each section shows status, the candidate-ID evidence notice, native label,
   and the platform's permission result.
3. Opening `native-branding-check.md` from each section downloads the matching
   artifact, and the report inside contains the candidate build ID and detailed
   result.
4. A controlled mismatch run names the mismatched field and its report link
   opens the uploaded failed report.

The user chose to keep this task in progress until that real run occurs.
