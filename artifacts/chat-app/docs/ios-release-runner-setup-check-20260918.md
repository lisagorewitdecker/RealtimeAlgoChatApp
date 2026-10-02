# iOS release runner provisioning check

**Result: BLOCKED — no Mac was available to run `scripts/provision-ios-runner.sh`
and register the self-hosted iOS runner**

This record is tracked because the prescribed `test-results/` directory is
gitignored. It records what was verified from the workspace and from the live
GitHub repository, which macOS-only behaviours were hardened before the first
real run, and what the owner must still supply before the iOS native release
job can execute on a self-hosted runner. No simulator, cloud runner, or
substitute host was used to stand in for the required Mac, and no credential
value was read or written while producing it.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-18 14:25:00 |
| App | Chat App |
| Workspace revision | `aa9419f` (local `main`) plus the script, harness, workflow, and documentation changes recorded below |
| Script under test | `scripts/provision-ios-runner.sh` (one-command macOS runner setup) |
| Workflow under test | `.github/workflows/mobile-release.yml` (`native-ios` job) |
| Required runner name and labels | `ios-release-mac`; `self-hosted`, `macos`, `ios`, `smallest-simulator` |
| Required runner tooling | Xcode with `simctl`, an iOS simulator runtime, booted `iPhone SE (3rd generation)`, Node 24, pnpm `10.26.1`, Java 17+, Maestro, Playwright Chromium, actions/runner `2.337.0` |
| Live GitHub runner count | 0 (see evidence below) |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Pinned runner release and digests still current | PASS | actions/runner `v2.337.0` is the latest release; the published `actions-runner-osx-arm64` and `actions-runner-osx-x64` SHA-256 digests match `RUNNER_SHA256_OSX_ARM64` and `RUNNER_SHA256_OSX_X64` in the script. |
| Token handoff matches the runner's contract | PASS | `src/Runner.Listener/CommandSettings.cs` at `v2.337.0` reads `ACTIONS_RUNNER_INPUT_TOKEN`, masks it, removes it from the environment block, and uses it when `--token` is absent, so the script never places the token on a command line. |
| `svc.sh` status wording matches the script's parsing | PASS | `src/Misc/layoutbin/darwin.svc.sh.template` at `v2.337.0` prints `not installed`, `Stopped`, or `Started:` plus the plist path, which is exactly what `install_service` matches. Reading it also showed that `svc.sh stop` runs `launchctl unload` and exits on its failure, which an installed-but-unloaded agent can trigger; the script now starts a stopped agent (which reads the new `.path`/`.env` anyway) instead of stopping and starting it (regression case `service-started-when-stopped-after-environment-change`). |
| bash 3.2 compatibility | PASS | bash 3.2.57 was built from source on Linux; `bash -n`, `--help`, the full `--dry-run`, and all 29 harness cases pass with the script and its stubs running under it (`PROVISION_TEST_BASH=/tmp/bash32/install/bin/bash`). No bash 4+ construct was found. |
| `simctl` text-listing tolerance | PASS (precautionary) | `latest_ios_runtime`, `find_simulator_udid`, the workflow's "Verify prepared iPhone SE simulator" step, and `artifacts/chat-app/e2e/native-large-text/run.sh` now accept trailing whitespace after the runtime identifier and the `(Booted)` state; the simulated-macOS harness case feeds padded listings and expects the runtime, the booted device, and the launch agent to be reported READY. |
| Simulator launch agent loading | PASS (precautionary) | `launchctl bootstrap` is retried briefly after `bootout` because the unload completes asynchronously; the harness fails the first bootstrap and expects a second attempt. |
| Self-hosted runner registered with required labels | BLOCKED | GitHub `/actions/runners` for the repository returns an empty runner list; this workspace has no macOS, Xcode, `xcrun`, `launchctl`, or `svc.sh`, so no host here can execute the real run. |
| Runner online and able to complete the iOS job | BLOCKED | No runner exists, so online status, reboot survival, and a real iOS job run cannot be demonstrated. |

## Exact workspace blocking evidence

```text
GitHub GET /repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners: 200, runners: [], total_count: 0 (2026-09-18 14:05 UTC)
GitHub GET /repos/lisagorewitdecker/RealtimeAlgoChatApp/environments/mobile-release: 200 (environment exists)
uname -s: Linux
xcrun: command not found
xcode-select: command not found
launchctl: command not found
```

## Companion automated checks at this revision

1. iOS runner provisioning suite
   (`scripts/tests/provision-ios-runner.test.sh`, 29 cases): **passed** under
   the workspace bash and under a locally built bash 3.2.57, including the
   new cases `service-left-running-when-environment-current`,
   `service-started-when-stopped-after-environment-change`,
   `service-restarted-when-started-after-environment-change`,
   `simulated-macos-boots-padded-simctl-listing`, and
   `simulated-macos-reports-simctl-create-failure`. Reverting the service
   ordering, the `(Booted)` whitespace tolerance, or the bootstrap retry
   makes the suite fail.
2. Workflow lint (`pnpm run validate:mobile-release-workflow`): **passed**.
3. iOS native large-text readiness suite
   (`scripts/tests/check-ios-native-large-text-readiness.test.sh`): **passed**
   after the `run.sh` pattern change.
4. Mobile release summary and caller contract suites
   (`scripts/tests/mobile-release-summary-contract.test.mjs`,
   `scripts/tests/mobile-release-caller-contract.test.mjs`): **passed**.
5. Shell syntax checks for the provisioning script, its harness, and
   `run.sh`: **passed**.

## Watch items for the first real run

These could not be settled from Linux and are the first things to read in the
owner's readiness report:

- Whether Xcode's current device catalogue still offers
  `com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation` for the
  newest available iOS runtime; if `simctl create` refuses, the
  `Booted iPhone SE (3rd generation)` row now reports MISSING with simctl's
  own reason (the script no longer discards that error text).
- Whether Homebrew's `node@24` ships `corepack`; the script falls back to
  `npm install -g corepack` and the pnpm row reports the outcome.
- The `Runner launch agent` row must read `(started)` with the plist path; a
  `not running` detail means the script was not run from the logged-in
  desktop session.

## Required next evidence

Complete these in order on the owner's Mac, then append a new tracked record
instead of editing this one:

1. From the logged-in desktop session (not SSH), in a checkout of this
   repository, run `./scripts/provision-ios-runner.sh --dry-run` and read the
   planned actions.
2. Run `./scripts/provision-ios-runner.sh`, supply the registration token only
   at its prompt (or through `RUNNER_TOKEN`), and share the readiness report;
   it lists names and statuses only and never contains the token or secret
   values.
3. Fix any macOS-only failure the report exposes in the script, extend
   `scripts/tests/provision-ios-runner.test.sh` where the Linux harness can
   model it, and rerun the script until every core row is READY.
4. Verify through GitHub CLI
   (`gh api repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners`)
   that `ios-release-mac` is `online` with all four labels, reboot the Mac,
   and confirm the simulator and runner launch agents both come back.
5. Trigger **Actions → Mobile release accessibility gate** and record the run
   URL, the runner name, and the successful iOS job evidence in the new
   record.
