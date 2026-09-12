# Native large-text release gate

Run the automated native smoke test on both release platforms before a store
release that changes shared text, forms, room headers, the embedded call surface,
or keyboard behavior. The gate uses an iPhone SE (3rd generation) simulator and
an Android emulator overridden to 320×568 dp.

## Prerequisites

1. Install the release-candidate app on a booted iPhone SE (3rd generation)
   simulator and a dedicated Android emulator configured at or below 320×568 dp.
2. Install [Maestro](https://maestro.mobile.dev/) and make `maestro` available on
   `PATH`.
3. Install Playwright Chromium once:
   `pnpm --filter @workspace/api-server exec playwright install chromium`.
4. Use a dedicated, verified Clerk test account with a saved display name. Sign
   in once manually if Clerk asks that simulator for a client-trust email code.
5. Export the following locally. Keep the password in a secret store, never in
   source control or shell history:

   - `NATIVE_SMOKE_APP_ID` — installed iOS bundle ID or Android application ID
   - `NATIVE_SMOKE_BUILD_ID` — EAS build ID for the release candidate installed on
     the prepared device
   - `NATIVE_SMOKE_EMAIL` — dedicated smoke-account email
   - `NATIVE_SMOKE_PASSWORD` — dedicated smoke-account password
   - `NATIVE_SMOKE_DISPLAY_NAME` — optional reusable display name

## Run

```sh
pnpm --filter @workspace/chat-app test:native-large-text ios
pnpm --filter @workspace/chat-app test:native-large-text android
```

The runner resolves the booted iPhone SE (3rd generation) by its UDID and passes
that exact device to Maestro, even when other simulators are also booted.
`runner-metadata.txt` records the selected `device_udid`. The runner refuses a
non-SE iOS simulator or an Android emulator larger than 320×568 dp for release
runs. It does not mutate simulator settings.

### Diagnostic-only runs on a larger iOS simulator

`NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1` is a local troubleshooting override for the
iOS runner only. It never produces release evidence:

- Setting it marks the whole run as diagnostic-only, even when an iPhone SE
  (3rd generation) happens to be booted. The readiness report is titled
  `iOS native large-text readiness (DIAGNOSTIC-ONLY)`, states
  `Run mode: **DIAGNOSTIC-ONLY** (not release evidence)`, and shows the
  simulator prerequisite as `OVERRIDDEN` with the accepted device name when a
  larger simulator was used. `runner-metadata.txt` and `pass-fail-record.txt`
  record `run_mode=diagnostic-only`, and console output is prefixed with
  `DIAGNOSTIC-ONLY RUN`.
- Diagnostic-only results default to
  `test-results/native-large-text-diagnostic/ios/<UTC timestamp>/`, outside the
  evidence directory, and the evidence completeness check rejects any pass
  record whose `run_mode` is not `release-gate`.
- Release workflow runs refuse the override. When `GITHUB_ACTIONS=true`, a
  runner with `NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1` in its environment fails the
  readiness check with a blocking prerequisite instead of running on a larger
  device, whatever simulator is booted.

To produce release evidence, unset the variable and re-run on a booted
iPhone SE (3rd generation). Release-gate runs state
`Run mode: **RELEASE GATE**` and record `run_mode=release-gate`.

## Mobile release pipeline

`.github/workflows/mobile-release.yml` runs the same commands as a release gate.
It is available from **Actions → Mobile release accessibility gate**, and also
runs for tags matching `mobile-v*`. The workflow has separate jobs for prepared
smallest-size simulators:

- The Android workflow first runs `scripts/check-android-release-prerequisites.sh`
  as a fast runner preflight. It reports
  `ANDROID_RELEASE_PREFLIGHT=BLOCKED` with each missing tool, secret, device, or
  device-configuration problem in the job summary, and the evidence job is not
  scheduled until the preflight reports `READY`.
- iOS runners must have the labels `self-hosted`, `macos`, `ios`, and
  `smallest-simulator`, with an iPhone SE (3rd generation) booted. The workflow
  resolves that simulator once, uses its UDID for native branding inspection,
  and requires the evidence gate to use the same UDID for Maestro screenshots.
- Android runners must have the labels `self-hosted`, `linux`, `android`, and
  `smallest-simulator`, with an emulator at or below 320×568 dp already booted.
- Both runners must have `pnpm`, `maestro`, and the platform tooling available.
  Android additionally requires Java 17 or newer and the standard `timeout`
  utility for bounded device readiness checks.
  The release-candidate app must already be installed with the app ID supplied
  to the workflow.
- The Android evidence job repeats the final device checks because separate
  self-hosted jobs may be assigned to different runners.

For a new Linux x86_64 runner, install the host prerequisites before running the
bootstrap script: Java 17 or newer, pnpm `10.26.1`, and Maestro. On an Ubuntu
runner, the host setup is typically:

```sh
sudo apt-get update
sudo apt-get install -y curl unzip coreutils openjdk-17-jre-headless
corepack enable
corepack prepare pnpm@10.26.1 --activate
curl -Ls https://get.maestro.mobile.dev | bash
```

Then provision the Android SDK and small portrait AVD, using a checksum obtained
from the pinned Android command-line-tools release:

```sh
ANDROID_CMDLINE_TOOLS_SHA256=<release-checksum> \
  ./scripts/provision-android-runner.sh --install-sdk
./scripts/provision-android-runner.sh --start-emulator
./scripts/provision-android-runner.sh
```

The final command is a read-only readiness check. It must report `adb`,
`sdkmanager`, `avdmanager`, `emulator`, Java, pnpm, and Maestro as available.
For a physical-device supplement, use the same host-tool check but connect the
representative phone over adb; the small-emulator size restriction applies to
the automated gate, not to the separate physical-device review.

Store the following values as secrets in the GitHub Actions `mobile-release`
environment. Authentication values are injected only into the process that
needs them and are never written to the repository or printed by the workflow.
The candidate build IDs are recorded in each smoke result directory so the
tested candidate can be audited by the publish job:

- `EAS_TOKEN` — EAS authentication token used only by the publish job
- `SENTRY_AUTH_TOKEN` — a masked Sentry token with release-upload and
  event-read access for organization `lisagorewitdecker-06`, project
  `react-native`; store the same token in the EAS release build environment and
  never use an `EXPO_PUBLIC_` name for it
- `NATIVE_SMOKE_IOS_BUILD_ID` — EAS build ID of the iOS candidate installed on
  the prepared iPhone SE simulator
- `NATIVE_SMOKE_ANDROID_BUILD_ID` — EAS build ID of the Android candidate
  installed on the prepared emulator
- `NATIVE_SMOKE_IOS_APP_ID`
- `NATIVE_SMOKE_ANDROID_APP_ID`
- `NATIVE_SMOKE_EMAIL`
- `NATIVE_SMOKE_PASSWORD`
- `NATIVE_SMOKE_DISPLAY_NAME` (optional)
- `NATIVE_SMOKE_IOS_SENTRY_RELEASE`
- `NATIVE_SMOKE_IOS_SENTRY_DIST`
- `NATIVE_SMOKE_ANDROID_SENTRY_RELEASE`
- `NATIVE_SMOKE_ANDROID_SENTRY_DIST`

Build each candidate with `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE`,
and `SENTRY_DIST` in its EAS release environment. EAS supplies `EAS_BUILD_ID`;
an equivalent prepared runner must supply `SENTRY_BUILD_ID`. The native build
preflight fails before bundling when the upload credential, release identity,
or candidate build identity is absent, automatic upload is disabled, or upload
failures are configured as non-blocking. `SENTRY_RELEASE`, `SENTRY_DIST`, and
the build ID are stamped into the JavaScript bundle, while the native Sentry
upload scripts use the release and distribution. Copy those non-secret values
into the matching GitHub environment entries above.

The `Mobile release gate` job always evaluates both platform jobs and fails if
either one fails. Configure that job as a required check for the mobile release
branch/tag protection, or call this workflow from a publishing workflow with
`workflow_call` and make the publishing job depend on its result. This workflow
also provides a `Publish tested mobile builds` job: it depends on
`mobile-release-gate` and submits the exact iOS and Android EAS build IDs used
by the smoke jobs. It never submits `--latest`. Tags and reusable workflow
callers run the evidence gate but cannot enter the store-submission job. A
manual run must set its `publish` input to true, provide both reviewed candidate
build IDs, and receive approval from the protected `mobile-store-submission`
GitHub environment. Each
platform job uploads its complete `test-results/native-large-text/<platform>/`
directory even when the smoke command fails, including JUnit, native
screenshots, and call-surface screenshots. Workflow evidence directories include
both the GitHub run ID and run-attempt number. Each platform uses a stable
artifact name and replaces only its own previous artifact after a successful
rerun. This lets a partial rerun combine fresh evidence from the failed platform
with the retained successful evidence from the other platform, and lets a
publish-only rerun retrieve both reviewed candidates.

Each run clears app data, enables the same persisted accessibility preferences
as the Profile controls, signs in, and exercises sign-in, setup, new-room create
and join states, room members and keyboard composer, call, and profile. Every
screen therefore runs with text size at **140%**, **High contrast** on, and
**Reduced motion** on. Assertions require primary controls to be visible while
keyboards are open.

After the layout checks, the runner opens a route that is not linked from the
normal application UI and submits one uniquely tagged, controlled JavaScript
exception. The route does not crash the app and is blocked unless it is running
inside a native candidate that passed the release preflight and the runner's
build ID matches the ID stamped into that candidate. GitHub then uses the
step-scoped `SENTRY_AUTH_TOKEN` to poll Sentry and requires the event to match
the candidate build ID, platform, release, and distribution. The named
controlled-probe function must appear as an in-app TypeScript or JavaScript
frame with a line and column; another mapped frame or a minified bundle-only
stack blocks release.

Results are written to a unique run directory:

`test-results/native-large-text/<platform>/<UTC timestamp>/`

Diagnostic-only iOS runs write to `test-results/native-large-text-diagnostic/`
instead, so they never sit next to release evidence.

The folder contains runner metadata, the candidate build ID, a pass/fail record,
a prefilled `review-record.template.txt`, the compiled native metadata,
`native-branding-check.md`, and the concise `native-branding-summary.md` used in
the GitHub job summary, both JUnit outputs, the controlled-error trigger record,
sanitized `sentry-source-map-evidence.json`, eleven native screenshots, and two
independent call-surface screenshots. The branding and Sentry reports record the
exact candidate build ID that supplied the inspected evidence. Treat a
missing artifact, failed visibility assertion, clipped-control geometry
assertion, keyboard-obscured primary action, release mismatch, or unreadable
stack as a release blocker.

The iOS and Android jobs append the branding summary after uploading their
artifact. It shows the check status, candidate build ID, native label, and
permission-copy or permission-declaration result. If branding fails, the
summary includes the mismatched field and links to the uploaded
`native-branding-check.md` report; the report remains the detailed audit record.

Review `runner-metadata.txt`, `pass-fail-record.txt`, `maestro-results.xml`,
`native-branding-check.md`, and all screenshots as described in
[Reviewing the evidence](#reviewing-the-evidence), then record the decision in
`review-record.txt` before changing a platform section of
`test-results/native-large-text/physical-device-supplement.md` from Blocked.

The call page is checked twice:

- Maestro captures the real embedded WebView inside each native host.
- A Playwright layout contract renders the call HTML by itself at 320×568 and
  375×667 with 140% text, forced high contrast, and reduced motion. This keeps a
  React Native host regression from masking a call-surface regression.

## Evidence completeness check

Before reviewing or publishing a candidate, run:

```sh
pnpm run validate:native-large-text-evidence
```

The check validates both `test-results/native-large-text/ios/` and
`test-results/native-large-text/android/`. Each platform must contain exactly
one timestamped run directory with non-empty candidate-build, runner/device
metadata, pass/fail, compiled native metadata, branding, both JUnit artifacts,
and candidate-bound Sentry source-map evidence. It also requires at least
eleven native screenshots and exactly two independent call-surface screenshots.
A failed or blocked pass record, a pass record that does not declare
`run_mode=release-gate` (including diagnostic-only iOS runs), a non-PASS
branding or Sentry report, or an empty artifact blocks release review.

`runner-check.txt` is host diagnostic evidence only. If it is the only file
available for a platform, the check reports that the platform is blocked rather
than treating the diagnostic as reviewed device evidence. Complete the run on
the prepared platform runner and upload its timestamped result directory.

The check also reads each run's `review-record.txt` (see
[Recording the review decision](#recording-the-review-decision)):

- A missing record is reported as `Review record missing` for that platform and
  the final summary lists the platforms as `Review pending`. The automated
  artifacts still pass, but the run is not reviewed device evidence until a
  person completes `review-record.template.txt` and renames it to
  `review-record.txt`. The template itself never counts as a completed review.
- `decision=REJECTED` fails the check and prints the reviewer, review time, and
  notes so the blocking findings stay visible.
- A record whose `candidate_build_id` does not match `candidate-build-id.txt`,
  whose `reviewed_at_utc` is earlier than the run's `recorded_at_utc`, whose
  `platform` names the other platform, or whose required fields are empty,
  still hold template placeholders, or use an unknown decision, fails the
  check. An ordinary review record covers exactly one evidence set. Only the
  publish workflow creates candidate-scoped records that can follow the same
  tested binary across workflow reruns.
- `decision=APPROVED` with consistent fields is echoed as an `APPROVED` review
  line naming the reviewer, review time, and candidate build ID, so the check
  output records who reviewed the evidence.

The default check intentionally allows missing records so the automated gate and
the pre-review local run can report `Review pending`. Store submission uses
strict mode:

```sh
NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 pnpm run validate:native-large-text-evidence
```

Strict mode fails unless both platform runs contain valid `APPROVED` records.
The publish job always runs this strict check before either `eas submit`.

### Supplying approvals to the publish job

Configure the GitHub `mobile-store-submission` environment with required
reviewers and place the publish-only `EAS_TOKEN` and candidate build-ID secrets
there. Do not permit self-review. This protected environment is the trusted
human approval boundary; the general `mobile-release` environment used by the
automated evidence jobs is not sufficient.

For **Actions → Mobile release accessibility gate**, set `publish` to true and
provide each platform's approved candidate build ID. The publish job waits for
the protected-environment approval, uses the read-only GitHub Actions API to
verify and record the actual environment approver, derives the review time from
the job clock, downloads the evidence, confirms each supplied candidate build
ID matches `candidate-build-id.txt`, confirms the EAS build IDs configured for
submission match that same evidence, writes the platform review records, and
runs the strict check before submission. Tags and reusable workflow callers
cannot reach the publish job.

The approval is keyed by candidate build ID rather than the workflow run ID. If
the evidence jobs are rerun and create new run directories for the same tested
candidates, the same recorded decisions can be supplied again; the publish job
marks these records with `approval_scope=candidate`. Every generated record,
including a candidate-scoped record, must postdate the evidence. A rebuilt
candidate has a different build ID and requires a new review. Tag-triggered runs
and reusable workflow callers cannot reach the publish job; use a manual
workflow dispatch with the reviewed candidate IDs to publish.

## Reviewing the evidence

Automated completeness proves that the expected files were uploaded. It does
not prove that anyone looked at them. Before a candidate is treated as reviewed
device evidence, one person must open every artifact in the run directory and
record the outcome.

## Manual physical-device supplement

The automated gate inspects the installed iOS `Info.plist` and compiled Android
manifest, but it cannot fully reproduce OEM keyboards, real camera/microphone
permission prompts, or every platform font rasterizer. Complete this short
physical-device pass for release candidates that change those areas. The
launcher label and permission-copy observations belong in the release review
alongside the automated `native-branding-check.md` report.

### Device settings

- In Profile → Accessibility, set text size to **140%**, turn **High contrast**
  on, and turn **Reduced motion** on.
- Keep the device in portrait orientation.
- Open the software keyboard anywhere an input is present.

### Screens

- **Sign in:** exercise password sign-in, client-trust verification, and every
  password-reset step. Confirm headings and OAuth labels wrap, all actions can be
  reached by scrolling, and the focused input stays above the keyboard.
- **Setup:** enter an invalid and then a valid display name. Confirm the error,
  hint, Sign out, and Enter workspace actions remain reachable with the keyboard
  open.
- **New room:** exercise Create and Join, including the room-key storage warning.
  Confirm the retry label wraps and the submit action remains reachable.
- **Room:** use a long room name and long member names, open the member list,
  scroll it, compose a multiline message, and open the keyboard. Confirm the
  header actions, moderation action, composer, and send control stay reachable.
- **Call:** confirm the blocked/loading copy and retry action are readable, then
  enter a call and check the embedded call controls independently.
- **Profile:** scroll the full page, edit the display name, and confirm all
  accessibility choices and the save action remain reachable.

Important copy must wrap rather than disappear behind neighboring controls. No
screen should require disabling large text or dismissing the keyboard to reach
its primary action.

### Call-surface screenshots

The call page is reviewed from two independent captures, and both must be
inspected:

- `screenshots/07-call-host-and-webview.png` is Maestro's capture of the real
  embedded WebView inside the native host on the tested device.
- `call-surface/android-small-140-percent.png` (320×568) and
  `call-surface/iphone-se-140-percent.png` (375×667) are Playwright renders of
  the call HTML by itself with 140% text, forced high contrast, and reduced
  motion. They are produced on the runner, not on the device, so they prove
  the layout contract of the call HTML rather than the native integration.

Compare them: the status text, name tag, and mute, camera, and end controls
must be fully visible in all three, with the video area ending above the
controls. A defect that appears only in the embedded capture points at the
native host (safe-area insets, WebView sizing, or keyboard handling); a defect
that appears in the Playwright renders as well points at the call HTML. Do not
treat the Playwright renders alone as proof that the call works on the device.

### What counts as device evidence

Only files inside a timestamped run directory produced by a completed run on
the prepared device are evidence: `screenshots/`, `call-surface/`,
`maestro-results.xml`, `runner-metadata.txt`, `pass-fail-record.txt`,
`candidate-build-id.txt`, `native-info.json`, and `native-branding-check.md`.

Runner diagnostics are not device evidence. `runner-check.txt`,
`ios-readiness.md`, the Android preflight job summary, and the readiness
sections of the workflow summary describe the host machine and its tooling.
They never show the app, so they cannot support any conclusion about wrapping,
clipping, keyboard behavior, or permission copy, and a `BLOCKED` readiness
status is a reason to fix the runner rather than a finding about the release.
Do not review them as evidence and never write a review record for a directory
that contains only diagnostics. A run whose `pass-fail-record.txt` reads
`run_mode=diagnostic-only` (started with `NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1`)
is a diagnostic run as well: its screenshots come from the wrong device class,
the evidence check rejects it, and it must not receive a review record.

Before opening the screenshots, confirm that the run belongs to the candidate
under review: `candidate-build-id.txt` must match the EAS build ID configured
for the release, `runner-metadata.txt` must name the expected platform and
device (an iPhone SE (3rd generation), or an Android device at or below 320×568
dp in portrait), `pass-fail-record.txt` must read `status=PASS`, and
`native-branding-check.md` must read `Status: **PASS**` for the same build ID.
Open `maestro-results.xml` and confirm that every test case passed; a passing
pass/fail record with failed JUnit cases means the run directory was assembled
by hand and must be rejected.

### Recording the review decision

After reviewing a platform's run, open the prefilled
`review-record.template.txt` next to `pass-fail-record.txt`. The runner has
already filled in `platform` and `candidate_build_id`. Replace every remaining
placeholder, then rename the completed file to `review-record.txt`:

```text
platform=ios
reviewer=<full name or handle>
reviewed_at_utc=<output of: date -u +%Y-%m-%dT%H:%M:%SZ>
candidate_build_id=<prefilled by the runner>
decision=<APPROVED or REJECTED>
# Keep notes=... for an optional one-line summary, or use this block for detailed findings.
notes<<END_NOTES
<optional multi-line findings; headings, bullets, links, and backticks are stored literally>
END_NOTES
```

- `reviewer` is the person who opened the screenshots and findings, not the
  person who ran the pipeline.
- `reviewed_at_utc` is when the review finished. It must be later than the
  run's `recorded_at_utc`; a review cannot predate the evidence it covers.
- `candidate_build_id` ties the decision to the tested candidate. If the
  candidate is rebuilt or the gate is rerun, review the new evidence and write
  a new record from that run's prefilled template; do not copy the old one or
  retype the build ID.
- Do not manually add `approval_scope=candidate`. That marker is reserved for
  approval records created by the protected publish workflow and follows the
  exact tested binary rather than a run-directory name.
- `decision` is `APPROVED` or `REJECTED`. Use `REJECTED` for any blocking
  finding and describe it in `notes` so the release check prints it.
- Existing `notes=...` records remain valid for a one-line note. For a checklist
  or multi-step finding, put the content between `notes<<END_NOTES` and the
  closing `END_NOTES` line. The closing delimiter must exactly match the one
  named after `notes<<`. The check prefixes every output line and treats
  headings, bullets, links, and backticks as literal evidence rather than
  Markdown.

Write one record per platform run; an iOS review never covers Android. Keep
the record in the run directory that is uploaded or stored under
`test-results/native-large-text/<platform>/`, then run
`pnpm run validate:native-large-text-evidence` again and confirm it prints an
`APPROVED` review line for both platforms before publishing or updating the
supplement document.

### Native screenshots

The flow captures eleven screens, numbered in the order they are exercised:

| File                              | Screen and required state                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `01-sign-in-keyboard.png`         | Sign in with credentials typed and the keyboard open: heading and OAuth labels wrap, primary action visible               |
| `02-password-reset.png`           | Password reset: heading, email input, and Back to sign in visible                                                         |
| `03-setup-invalid-keyboard.png`   | Setup with a one-character name: validation error, hint, and Sign out visible                                             |
| `04-setup-valid-keyboard.png`     | Setup with a valid display name typed: Enter workspace visible                                                            |
| `05-new-room-create-keyboard.png` | New room (Create) with a long name typed: submit action visible                                                           |
| `06-room-keyboard.png`            | Room with a long name, member list open, and a wrapping message composed: call and member actions, composer, send visible |
| `07-call-host-and-webview.png`    | Call page inside the native host: embedded WebView, fit confirmation text, and dismiss action visible                     |
| `08-new-room-join-keyboard.png`   | New room (Join) with a room ID typed: submit action visible                                                               |
| `09-joined-room.png`              | Joined room: header and participant count visible                                                                         |
| `10-profile-accessibility.png`    | Profile accessibility controls reading Current size 140%, High contrast on, and Reduced motion on                         |
| `11-profile-edit-keyboard.png`    | Profile display-name edit with the keyboard open: save action visible                                                     |

Open each file at full size and check the same four things on every screen:

1. **Settings applied.** Text is visibly larger than the default and the
   high-contrast palette is in use. A screenshot with default-size text means
   the persisted preferences were not applied and the run is invalid.
2. **Nothing clipped.** No label is cut off at the screen edge or hidden behind
   a neighboring control, and long headings, OAuth labels, member names, and
   the retry label wrap onto extra lines rather than truncating.
3. **Primary action visible with the keyboard open.** On every `*-keyboard.png`
   screen the keyboard is actually shown and the screen's primary action
   (submit, send, save, Enter workspace) is still on screen above it.
4. **Right screen, right device.** The file shows the screen named in the table
   and the device chrome matches `runner-metadata.txt`. A screenshot of the
   wrong screen means an assertion passed against the wrong view.

Record anything that fails, and anything that passes only marginally (for
example, a control that touches the keyboard edge), as a finding.
