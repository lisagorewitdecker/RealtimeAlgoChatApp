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

The GitHub `main` branch is the source of truth for this workflow. Before a
release run, reconcile project changes with `main` and push the resulting
`.github/workflows/mobile-release.yml`; do not run a release from a workspace
copy or another branch that has not been synchronized with `main`.

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

### Checking Android runner health before a release

The workflow includes a GitHub-hosted **Android release runner health** job.
It uses the read-only Actions API to verify that the repository has at least
one online runner with all four labels required by the Android jobs:
`self-hosted`, `linux`, `android`, and `smallest-simulator`. Its job summary
lists offline runners and the exact labels missing from otherwise eligible
runners. It does not read or print registration tokens, release credentials,
or other secret values.

To run only this check, open **Actions → Mobile release accessibility gate →
Run workflow**, leave **Publish** disabled, and enable
`android_runner_health_only`. The health job links back to this procedure and
the other release jobs are skipped. Normal release runs perform the same
check first; a failed health check prevents the Android self-hosted preflight
from being scheduled.

For a new Linux x86_64 runner, create the service account before any
user-scoped SDK, AVD, or Maestro installation. Install the host prerequisites
as root, but run the bootstrap as `actions` so its `$HOME` is the same home
used by the emulator service:

```sh
export RUNNER_USER=actions
sudo useradd --create-home --shell /bin/bash "$RUNNER_USER" 2>/dev/null || true
sudo usermod --append --groups kvm "$RUNNER_USER"
sudo apt-get update
sudo apt-get install -y curl unzip coreutils git openjdk-17-jre-headless
sudo corepack enable
sudo corepack prepare pnpm@10.26.1 --activate
sudo -u "$RUNNER_USER" -H bash -lc 'curl -Ls https://get.maestro.mobile.dev | bash'
if [ ! -d /home/"$RUNNER_USER"/RealtimeAlgoChatApp/.git ]; then
  sudo -u "$RUNNER_USER" -H git clone \
    https://github.com/lisagorewitdecker/RealtimeAlgoChatApp.git \
    /home/"$RUNNER_USER"/RealtimeAlgoChatApp
fi
```

Then provision the Android SDK and small portrait AVD, using a checksum obtained
from the pinned Android command-line-tools release. Replace the checksum
placeholder with the published value before running this block:

The checked-in pin contract at
`scripts/android-runner-pins.sh` is the source of truth for the GitHub Actions
runner archive version, runner SHA-256 digest, and Android build-tools version.
Keep the literal values in the procedure below synchronized with that file in
one reviewed change.

```sh
sudo -u "$RUNNER_USER" -H bash -lc '
  cd "$HOME/RealtimeAlgoChatApp"
  ANDROID_CMDLINE_TOOLS_SHA256=REPLACE_WITH_RELEASE_CHECKSUM \
    ./scripts/provision-android-runner.sh --install-sdk
'
```

The final readiness check below is read-only. It must report `adb`,
`sdkmanager`, `avdmanager`, `emulator`, `aapt2`, Java, pnpm, and Maestro as
available.
For a physical-device supplement, use the same host-tool check but connect the
representative phone over adb; the small-emulator size restriction applies to
the automated gate, not to the separate physical-device review.

### Registering and keeping the Linux runner online

The SDK bootstrap does not register a GitHub Actions runner. Register the
runner on the Linux host after the host and emulator checks pass. Keep the
runner directory outside the application checkout:

```sh
sudo install --directory --owner="$RUNNER_USER" --group="$RUNNER_USER" /opt/actions-runner
```

Install the pinned GitHub runner release and verify its published digest before
extracting it. The release asset and digest below are the pinned Linux x64
runner used by this procedure; update both together when rotating the runner:

```sh
cd /opt/actions-runner
RUNNER_VERSION=2.337.0
RUNNER_ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
sudo -u "$RUNNER_USER" curl --fail --location --silent --show-error \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}" \
  --output "$RUNNER_ARCHIVE"
printf '%s  %s\n' \
  70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613 \
  "$RUNNER_ARCHIVE" | sha256sum --check --status
sudo -u "$RUNNER_USER" tar --extract --gzip --file "$RUNNER_ARCHIVE"
sudo rm "$RUNNER_ARCHIVE"
```

Put the Android paths in the runner environment so the service sees the same
tools as an interactive shell:

```sh
sudo tee /opt/actions-runner/.env >/dev/null <<'EOF'
HOME=/home/actions
ANDROID_SDK_ROOT=/home/actions/android-sdk
ANDROID_HOME=/home/actions/android-sdk
PATH=/home/actions/.maestro/bin:/home/actions/android-sdk/platform-tools:/home/actions/android-sdk/emulator:/home/actions/android-sdk/cmdline-tools/latest/bin:/home/actions/android-sdk/build-tools/35.0.0:/usr/local/bin:/usr/bin:/bin
EOF
sudo chown "$RUNNER_USER":"$RUNNER_USER" /opt/actions-runner/.env
```

Request a short-lived registration token with an authenticated GitHub CLI
session, configure the exact labels expected by `mobile-release.yml`, then
remove the token from the shell environment:

```sh
cd /opt/actions-runner
RUNNER_TOKEN="$(gh api --method POST \
  repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners/registration-token \
  --jq .token)"
sudo -u "$RUNNER_USER" -H ./config.sh \
  --unattended \
  --url https://github.com/lisagorewitdecker/RealtimeAlgoChatApp \
  --token "$RUNNER_TOKEN" \
  --name android-release-linux \
  --labels self-hosted,linux,android,smallest-simulator \
  --work _work
unset RUNNER_TOKEN
sudo ./svc.sh install "$RUNNER_USER"
```

Keep the emulator available before the Actions service starts, and make the
runner wait for Android boot completion. First install this root-owned wait
helper:

```sh
sudo tee /usr/local/sbin/wait-for-android-native-emulator >/dev/null <<'EOF'
#!/bin/sh
set -eu
adb=/home/actions/android-sdk/platform-tools/adb
"$adb" wait-for-device
while [ "$("$adb" shell getprop sys.boot_completed | tr -d '\r')" != "1" ]; do
  sleep 2
done
"$adb" shell settings put system accelerometer_rotation 0
"$adb" shell settings put system user_rotation 0
EOF
sudo chmod 0755 /usr/local/sbin/wait-for-android-native-emulator
```

Use this systemd unit. Its `ExecStartPost` does not finish until Android is
booted, so a dependent runner service cannot accept a job against a starting
emulator:

```ini
# /etc/systemd/system/android-native-emulator.service
[Unit]
Description=Android native release emulator
After=network-online.target
Wants=network-online.target

[Service]
User=actions
Environment=HOME=/home/actions
Environment=ANDROID_HOME=/home/actions/android-sdk
Environment=ANDROID_SDK_ROOT=/home/actions/android-sdk
ExecStart=/home/actions/android-sdk/emulator/emulator @native-small-api35 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect
ExecStartPost=/usr/bin/timeout 120 /usr/local/sbin/wait-for-android-native-emulator
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Add an ordering drop-in to the service installed by `svc.sh`. The generated
name is stable for this repository and runner name; if the runner package
prints a different escaped name, use that name instead:

```sh
RUNNER_SERVICE=actions.runner.lisagorewitdecker-RealtimeAlgoChatApp.android-release-linux.service
sudo mkdir --parents "/etc/systemd/system/${RUNNER_SERVICE}.d"
sudo tee "/etc/systemd/system/${RUNNER_SERVICE}.d/10-android-emulator.conf" >/dev/null <<'EOF'
[Unit]
Requires=android-native-emulator.service
After=android-native-emulator.service
EOF
```

After writing the unit and drop-in, start the emulator first, then the runner,
and run the final checks as the runner user:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now android-native-emulator.service
RUNNER_SERVICE=actions.runner.lisagorewitdecker-RealtimeAlgoChatApp.android-release-linux.service
sudo systemctl is-active --quiet android-native-emulator.service
emulator_processes="$(pgrep -fc '[a]ndroid-sdk/emulator/emulator @native-small-api35')"
if [ "$emulator_processes" -ne 1 ]; then
  printf 'Expected exactly one systemd-managed Android emulator, found %s.\n' \
    "$emulator_processes" >&2
  exit 1
fi
sudo systemctl enable --now "$RUNNER_SERVICE"
sudo -u actions -H bash -lc 'cd "$HOME/RealtimeAlgoChatApp" && ./scripts/provision-android-runner.sh'
gh api repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners \
  --jq '.runners[] | select(.name == "android-release-linux") |
  {name, status, busy, labels: [.labels[].name]}'
```

The API result must show `status: "online"` and all four labels. The final
release preflight must then report `ANDROID_RELEASE_PREFLIGHT=READY` after the
candidate APK and `mobile-release` environment values have been supplied.
Do not run untrusted pull-request code on this public-repository runner; keep
approval required for outside contributors and rely on the workflow's
non-pull-request condition for the native release jobs.

### Setting up the macOS runner with one command

The `native-ios` job runs only on a self-hosted Mac with the labels
`self-hosted`, `macos`, `ios`, and `smallest-simulator`, an iPhone SE
(3rd generation) simulator booted, pnpm 10.26.1, Java 17 or newer, Maestro,
Playwright Chromium, and the release candidate installed.
`scripts/provision-ios-runner.sh` installs or verifies all of that, registers
the GitHub Actions runner, and installs it as a launch agent. It stays
compatible with the bash 3.2 that ships with macOS.

Before running it:

1. Install the full Xcode from the App Store (the Command Line Tools alone do
   not provide `simctl`), open it once, and accept the license. The script
   downloads the iOS simulator runtime when none is available.
2. Sign in to the Mac's desktop session and run the script from Terminal in
   that session, not over SSH. Launch agents are loaded into the logged-in
   user's session, and the simulator needs a window server.
3. Clone the repository on the Mac. The script reads the pinned Playwright
   version from the checkout, so run it from inside the clone.

Preview every action first, then run it for real:

```sh
cd ~/RealtimeAlgoChatApp
./scripts/provision-ios-runner.sh --dry-run
./scripts/provision-ios-runner.sh
```

The dry run prints each install, download, registration, and service command
without changing anything; it also works on Linux, where the macOS-only checks
are reported as `SKIPPED`. The real run:

- installs Homebrew, `node@24`, `openjdk@17`, pnpm 10.26.1 through corepack,
  Maestro, and Playwright Chromium when they are missing;
- creates the iPhone SE (3rd generation) simulator when it does not exist,
  boots it, and writes a second launch agent that boots it again at every
  login (the agent runs `simctl boot` and then `simctl bootstatus -b`, so
  it works after a reboot when nothing else has booted the device);
- downloads the pinned GitHub runner release (the same `RUNNER_VERSION` as the
  Linux procedure above), verifies its published SHA-256 digest before
  extracting it into `~/actions-runner`, and registers it unattended as
  `ios-release-mac` with `--labels self-hosted,macos,ios,smallest-simulator`;
- writes the runner's `.path` and `.env` files so Maestro, Homebrew, Node,
  Java, and `JAVA_HOME` are visible to the service, then runs
  `./svc.sh install && ./svc.sh start`. These service steps run only for a
  registration the script created or verified, and only while every core
  prerequisite is `READY`; otherwise they are reported `MISSING` and any
  existing launch agent is left untouched.

The runner registration token comes from `RUNNER_TOKEN`, from an authenticated
GitHub CLI session (`gh auth login`), or from a hidden prompt when the script
runs interactively. The script never accepts the token as a command-line
argument and never prints it; it hands the token to `config.sh` through the
runner's `ACTIONS_RUNNER_INPUT_TOKEN` environment input rather than a
`--token` argument, so it never appears in a process list, and clears both
variables as soon as registration finishes. Generate the token from
**Settings → Actions → Runners → New self-hosted runner** (macOS), or with
`gh api --method POST repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners/registration-token`;
it expires after one hour. Registration is skipped, with an `INCOMPLETE`
report, while any core prerequisite (Xcode, the simulator runtime, pnpm, Java,
Maestro, or the booted simulator) is still missing, so GitHub never routes the
iOS job to a Mac that cannot run it. Re-run the script after fixing the
reported rows. On a re-run, an existing `~/actions-runner/.runner` counts as
registered only when it names this repository and the expected runner name
and its labels are verified: by GitHub when the CLI is authenticated (the
runner must still exist there with all four labels), otherwise by the record
the script wrote at registration (`~/actions-runner/.provision-ios-runner`,
which must describe the same runner). Anything else, including a registration
made by hand whose labels cannot be checked, is reported `MISSING` together
with the `./config.sh remove` step that clears the stale registration, and
the service is neither installed nor started. To register the runner under a
different name or directory, set `RUNNER_NAME` or `RUNNER_ROOT`;
`--skip-registration` prepares the host only.

Install the release candidate through the same script once the simulator is
booted. Point it at the EAS simulator build (a `.tar.gz`) or an unpacked
`.app` bundle kept outside the repository, and export the bundle identifier
so later runs can verify the installation without reinstalling:

```sh
NATIVE_SMOKE_IOS_APP_ID=<bundle identifier> \
NATIVE_SMOKE_IOS_APP_PATH=/secure/path/candidate-simulator.tar.gz \
  ./scripts/provision-ios-runner.sh --install-candidate
```

The candidate row is `READY` only when the app is installed on the booted
simulator and carries the crash-reporting preflight marker, matching the
check the workflow performs before the gate runs. The script never prints the
bundle identifier or any secret value.

Service and PATH caveats for a Mac that must stay online:

- The launch agents run only while the runner user is logged in. Enable
  automatic login for that user (**System Settings → Users & Groups**), and
  disable sleep and the screen lock so the simulator keeps a window server.
- The runner service does not read `~/.zshrc` or `~/.bash_profile`. Anything
  installed later must be added to `~/actions-runner/.path` (or the script
  re-run, which rewrites `.path` and `.env` and restarts the service).
- The runner self-updates past the pinned release after registration; the pin
  and digest only protect the initial download. Rotate the pin in the script
  and in this document together.
- After a reboot the simulator launch agent needs about a minute to finish
  booting before the runner can pass the simulator check; a run started
  during that window fails the readiness step and can simply be re-run.
- Runner registration writes `~/actions-runner/.runner` and
  `~/actions-runner/.credentials`; keep the runner directory out of any
  backup or sync that leaves the Mac.

The script ends with a readiness report: a table of prerequisites marked
`READY`, `MISSING`, or `SKIPPED`, the resulting runner name and labels, and
the names of the GitHub configuration the iOS job still needs. Its last line is
`IOS_RELEASE_RUNNER=READY` (exit status 0) or `IOS_RELEASE_RUNNER=INCOMPLETE`
(exit status 1; a dry run always exits 0). The GitHub configuration it lists
is:

- environment `mobile-release` secrets `NATIVE_SMOKE_IOS_APP_ID`,
  `NATIVE_SMOKE_EMAIL`, `NATIVE_SMOKE_PASSWORD`, `SENTRY_AUTH_TOKEN`,
  `NATIVE_SMOKE_IOS_SENTRY_RELEASE`, and `NATIVE_SMOKE_IOS_SENTRY_DIST`, plus
  the optional `NATIVE_SMOKE_DISPLAY_NAME`;
- the repository-level variable `NATIVE_SMOKE_IOS_BUILD_ID` described below.

When the GitHub CLI is installed and authenticated, the script offers to
confirm that the runner is online and to report which of those names already
exist (names only, never values); pass `--check-github` to do so without a
prompt or `--no-github` to skip it. The same confirmation is available
directly:

```sh
gh api repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners \
  --jq '.runners[] | select(.name == "ios-release-mac") | {name, status, busy, labels: [.labels[].name]}'
```

The result must show `"status": "online"` and all four labels.

This is a public repository, so before relying on the self-hosted Mac, set
**Settings → Actions → General → Approval for running fork pull request
workflows from contributors** to require approval for all outside
collaborators. The native release jobs additionally skip pull-request events,
but the approval setting is what keeps unreviewed fork code off the runner.

Do not start the first real release run until the repository sync task has
pushed the current `.github/workflows/mobile-release.yml` to `main`: the
runner labels, the `mobile-release` environment, and the secret names above
are read from the workflow on `main`, not from a local checkout.

`pnpm --filter @workspace/scripts run test:ios-runner` exercises the script's
dry-run path on Linux and fails when its labels, pinned runner release, pnpm
version, or readiness report drift from the workflow and this document. It
also drives the macOS-only branches through stubs (`uname` reporting Darwin,
`xcrun simctl` listings padded with trailing whitespace, a device type list
with and without the iPhone SE, `launchctl` bootstrap failing once after
bootout, `svc.sh` in every service state) and runs the report checker suite
described below. macOS ships bash 3.2, so run the suite with
`PROVISION_TEST_BASH=/path/to/bash-3.2` pointing at a locally built bash
3.2.57 before changing the script; the default run uses the workspace bash.
The hosted Mac check below runs the same suites under Apple's `/bin/bash`.

Store the candidate build IDs as repository-level GitHub Actions
**variables**:

- `NATIVE_SMOKE_IOS_BUILD_ID` — EAS build ID of the iOS candidate installed on
  the prepared iPhone SE simulator
- `NATIVE_SMOKE_ANDROID_BUILD_ID` — EAS build ID of the Android candidate
  installed on the prepared emulator

These IDs are non-secret release configuration and appear literally alongside
their SHA-256 fingerprints in the release summary. Reusable-workflow callers
instead pass the required `native_smoke_ios_build_id` and
`native_smoke_android_build_id` inputs.

### Checking the Mac setup script on a GitHub-hosted Mac

The Linux suite can only simulate Xcode. Two facts about a real Mac stay
unverified from the workspace: whether the text output of `xcrun simctl list`
pads its lines (the patterns tolerate padding precautionarily) and whether the
installed Xcode still offers
`com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation`. The
`iOS runner provisioning real macOS` workflow
(`.github/workflows/ios-runner-provisioning-real-macos.yml`) answers both on a
GitHub-hosted `macos-latest` runner, which ships Apple's `/bin/bash` 3.2, a
real Xcode, `xcrun`, `simctl`, and `launchctl`, so breakage surfaces on GitHub
instead of on the owner's Mac. Its single job:

1. runs `scripts/tests/provision-ios-runner.test.sh` and
   `scripts/tests/check-ios-runner-dry-run-report.test.sh` with
   `PROVISION_TEST_BASH=/bin/bash`, so every stub and the script itself run
   under the bash the Mac will use;
2. runs `/bin/bash ./scripts/provision-ios-runner.sh --dry-run --no-github`
   with stdin closed, `RUNNER_NAME=ios-release-mac`, and an empty
   `RUNNER_ROOT` under the job's temporary directory. The dry run performs the
   real Xcode and `simctl` detection, runtime listing, device type lookup, and
   simulator lookup; it never registers a runner, never reads a registration
   token (none exists in the job), never calls the GitHub CLI, and never
   installs a launch agent;
3. runs `scripts/check-ios-runner-dry-run-report.sh` on the transcript. The
   check fails when the `Xcode with simctl` row or the `iOS simulator runtime`
   row is anything other than `READY` (on a hosted Mac that means the
   detection or the listing parser broke), when the
   `Booted iPhone SE (3rd generation)` row is neither `READY` nor a `MISSING`
   row that plans the boot or the creation on a parsed runtime (an unavailable
   device type reports `cannot be created: ... is not offered by the installed
   Xcode`), when the transcript was not produced by a dry run on macOS, or
   when the run stopped before `IOS_RELEASE_RUNNER=`. Its last line is
   `IOS_RUNNER_DRY_RUN_CHECK=PASS` or `IOS_RUNNER_DRY_RUN_CHECK=FAIL`, and it
   appends the readiness report, sanitized and bounded, to the job summary.
   The report lists configuration names only, never values.

The job runs for pull requests and pushes to `main` that touch the script, the
shared contract, the checker, or their tests, weekly on a schedule (GitHub
pauses schedules after sixty days without repository activity; re-enable the
workflow from the Actions tab if that happens), and on demand through
**Run workflow**. The hosted Mac never has pnpm, Java, or Maestro prepared,
so those rows stay `MISSING` with install plans and the report always ends in
`IOS_RELEASE_RUNNER=INCOMPLETE`; the job judges only the Xcode-dependent rows.
Run it before the owner's first provisioning run whenever the script or the
Xcode on `macos-latest` changed, and read the quoted report in the job summary
when it fails. `pnpm run validate:github-workflows` lints the workflow file
and `node --test scripts/tests/ios-runner-real-macos-workflow.test.mjs` keeps
it read-only (no secrets, no `config.sh`, no `svc.sh`) and pinned.

### Updating reusable-workflow callers

Callers maintained in another repository must pass both candidate IDs through
`with`, not through `secrets`. Keep authentication and account credentials in
the existing secrets contract:

```yaml
jobs:
  mobile-release:
    uses: <owner>/<repository>/.github/workflows/mobile-release.yml@<ref>
    with:
      native_smoke_ios_build_id: ${{ vars.NATIVE_SMOKE_IOS_BUILD_ID }}
      native_smoke_android_build_id: ${{ vars.NATIVE_SMOKE_ANDROID_BUILD_ID }}
    secrets: inherit
```

If the caller receives the IDs from an earlier build job, use that job's
outputs for the two `with` values instead. The called workflow requires both
inputs, so a caller that omits either one fails before the release jobs start.

Migrate and retire the old caller-side build-ID secrets in this order:

1. Add both non-secret variables or build-job outputs to the caller.
2. Pass both values through `with` and run the reusable workflow successfully
   for the exact installed candidates.
3. Confirm the release summary shows those candidate IDs and fingerprints.
4. Delete only the caller-side `NATIVE_SMOKE_IOS_BUILD_ID` and
   `NATIVE_SMOKE_ANDROID_BUILD_ID` secrets.

Do not replace `secrets: inherit` while making this change. The authentication,
test-account, Sentry, Clerk, and database values listed below still cross the
reusable-workflow secrets boundary.

The called workflow validates these credentials in one hosted setup preflight.
When required credentials are absent, the preflight reports every missing key
together before native runners or release regressions start. It names keys only,
never values. GitHub's reusable-workflow declarations leave the secrets
syntactically optional so this aggregate diagnostic can run; the preflight list
below is the blocking required contract. `NATIVE_SMOKE_DISPLAY_NAME` remains
optional and is not included in that failure. The publish-only `EAS_TOKEN` also
stays out of this preflight and remains available only after approval from the
protected `mobile-store-submission` environment.

Store the runner-read token below as a repository Actions **secret** so manual
dispatches can use it, and pass it through the reusable-workflow secret contract.
Store the release credentials in the GitHub Actions `mobile-release` environment.
Authentication values are injected only into the process that needs them and
are never written to the repository or printed by the workflow.
The candidate build IDs are recorded in each smoke result directory so the
tested candidate can be audited by the publish job:

#### Required reusable-workflow secrets

- `GITHUB_WORKFLOW_PULL_TOKEN_FINAL` — a dedicated fine-grained GitHub token
  scoped to this repository with **Administration: read** permission, used only
  by the hosted Android runner-health job to read
  `GET /repos/<owner>/<repo>/actions/runners`; it must not be a registration
  token or a release credential
- `SENTRY_AUTH_TOKEN` — a masked Sentry token with release-upload and
  event-read access for organization `lisagorewitdecker-06`, project
  `react-native`; store the same token in the EAS release build environment and
  never use an `EXPO_PUBLIC_` name for it
- `NATIVE_SMOKE_IOS_APP_ID`
- `NATIVE_SMOKE_ANDROID_APP_ID`
- `NATIVE_SMOKE_EMAIL`
- `NATIVE_SMOKE_PASSWORD`
- `NATIVE_SMOKE_IOS_SENTRY_RELEASE`
- `NATIVE_SMOKE_IOS_SENTRY_DIST`
- `NATIVE_SMOKE_ANDROID_SENTRY_RELEASE`
- `NATIVE_SMOKE_ANDROID_SENTRY_DIST`
- `E2E_CHAT_URL` — browser-test target for the Chat App
- `E2E_API_URL` — browser-test target for the API server
- `CLERK_PUBLISHABLE_KEY` — Clerk publishable key used by the browser test target
- `CLERK_SECRET_KEY` — Clerk secret key used by the API server during browser setup
- `DATABASE_URL` — database connection used by the API server during browser setup

#### Optional reusable-workflow secrets

- `NATIVE_SMOKE_DISPLAY_NAME` — reusable display name for the smoke account; the
  test flow can register the account without a preconfigured value

#### Publish-only secret

- `EAS_TOKEN` — EAS authentication token used only by the publish job; store it
  in the protected `mobile-store-submission` environment, not `mobile-release`

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
summary names the mismatched or unavailable field (or reports that the
candidate metadata could not be inspected when the file is unreadable or not
valid JSON) and links to the uploaded `native-branding-check.md` report; the
report remains the detailed audit record. Parser details never reach the
summary or the workflow log; inspect the uploaded `native-info.json` instead.

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

Both JUnit artifacts must also be well-formed XML holding a `testsuite`
element. A truncated upload, or a captured log that merely mentions a
`testsuite` element, is rejected on structure alone: the diagnostic names the
file path and the structural reason, and never quotes what the file contains.
Open the uploaded report itself to see why the run stopped.

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
reviewers and place the publish-only `EAS_TOKEN` secret there. Candidate build
IDs continue to come from the non-secret repository variables. Do not
permit self-review. This protected environment is the trusted
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
