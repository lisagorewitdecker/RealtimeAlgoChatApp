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

The runner refuses a non-SE iOS simulator or an Android emulator larger than
320×568 dp for release runs. It does not mutate simulator settings.

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
  `smallest-simulator`, with an iPhone SE (3rd generation) booted.
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
- `NATIVE_SMOKE_IOS_BUILD_ID` — EAS build ID of the iOS candidate installed on
  the prepared iPhone SE simulator
- `NATIVE_SMOKE_ANDROID_BUILD_ID` — EAS build ID of the Android candidate
  installed on the prepared emulator
- `NATIVE_SMOKE_IOS_APP_ID`
- `NATIVE_SMOKE_ANDROID_APP_ID`
- `NATIVE_SMOKE_EMAIL`
- `NATIVE_SMOKE_PASSWORD`
- `NATIVE_SMOKE_DISPLAY_NAME` (optional)

The `Mobile release gate` job always evaluates both platform jobs and fails if
either one fails. Configure that job as a required check for the mobile release
branch/tag protection, or call this workflow from a publishing workflow with
`workflow_call` and make the publishing job depend on its result. This workflow
also provides a `Publish tested mobile builds` job: it depends on
`mobile-release-gate` and submits the exact iOS and Android EAS build IDs used
by the smoke jobs. It never submits `--latest`. A `mobile-v*` tag publishes
automatically; a manual run must set its `publish` input to true; reusable
workflow callers publish when they pass the required EAS secrets. Each platform
job uploads its complete `test-results/native-large-text/<platform>/` directory
even when the smoke command fails, including JUnit, native screenshots, and
call-surface screenshots.

Each run clears app data, enables the same persisted accessibility preferences
as the Profile controls, signs in, and exercises sign-in, setup, new-room create
and join states, room members and keyboard composer, call, and profile. Every
screen therefore runs with text size at **140%**, **High contrast** on, and
**Reduced motion** on. Assertions require primary controls to be visible while
keyboards are open.

Results are written to a unique run directory:

`test-results/native-large-text/<platform>/<UTC timestamp>/`

The folder contains runner metadata, the candidate build ID, a pass/fail record,
the compiled native metadata and `native-branding-check.md`, JUnit output,
eleven native screenshots, and two independent call-surface screenshots. The
branding report records the exact candidate build ID that supplied the
inspected metadata. Treat a missing screenshot, failed visibility
assertion, clipped-control geometry assertion, or keyboard-obscured primary
action as a release blocker.

Review `runner-metadata.txt`, `pass-fail-record.txt`, `maestro-results.xml`, and
`native-branding-check.md`, and all screenshots before changing the Android section of
`test-results/native-large-text/physical-device-supplement.md` from Blocked.

The call page is checked twice:

- Maestro captures the real embedded WebView inside each native host.
- A Playwright layout contract renders the call HTML by itself at 320×568 and
  375×667 with 140% text, forced high contrast, and reduced motion. This keeps a
  React Native host regression from masking a call-surface regression.

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
