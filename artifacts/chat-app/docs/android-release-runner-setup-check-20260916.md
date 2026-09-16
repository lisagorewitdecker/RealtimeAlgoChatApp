# Android release runner provisioning check

**Result: BLOCKED — no KVM-capable Linux host was available to register the
self-hosted Android runner**

This record is tracked because the prescribed `test-results/` directory is
gitignored. It records what was verified from the workspace and from the live
GitHub repository, and what the owner must still supply before the Android
native release job can execute on a self-hosted runner. No simulator, cloud
runner, or substitute host was used to stand in for the required self-hosted
runner, and no credential value was read or written while producing it.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-16 16:00:00 |
| App | Chat App |
| Workspace revision | `2b34bda` (local `main`) |
| Workflow under test | `.github/workflows/mobile-release.yml` (Android native release job) |
| Required runner labels | `self-hosted`, `linux`, `android`, `smallest-simulator` |
| Required runner tooling | Node 24, pnpm `10.26.1`, `adb`, `aapt2`, prepared small Android emulator, Maestro |
| Live GitHub runner count | 0 (see evidence below) |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Operator setup/check procedure recorded and repeatable | PASS | The Linux runner section of [`native-large-text-device-check.md`](./native-large-text-device-check.md) covers the dedicated `actions` account, user-scoped SDK/AVD/Maestro installs, pinned runner `2.337.0` download with published SHA-256 verification, exact label registration, systemd services for emulator and runner, and GitHub CLI online/label verification. |
| Emulator lifecycle owned by systemd and boot-gated | PASS | The procedure makes the systemd emulator service the sole emulator owner (no unmanaged `nohup` launch), waits for `sys.boot_completed=1` via `ExecStartPost`, and orders the runner service after the emulator service so jobs are never accepted before Android is booted. |
| `aapt2` verified by provisioning and release preflight | PASS | `scripts/provision-android-runner.sh` resolves the configured build-tools directory and verifies `aapt2`; `scripts/check-android-release-prerequisites.sh` fails closed when `aapt2` is unavailable. |
| Companion regression suites | PASS | Android preflight fixtures cover `aapt2`; `check-android-runner-procedure.test.sh` fails if the documented procedure launches an unmanaged emulator or drops the systemd boot ordering; the native large-text readiness suite passes at this revision. |
| Self-hosted runner registered with required labels | BLOCKED | GitHub `/actions/runners` for the repository returns an empty runner list; this workspace has no Java, Android SDK, `adb`, `emulator`, Maestro, or `/dev/kvm`, so no host here can execute the registration. |
| Runner online and able to complete the Android job | BLOCKED | No runner exists, so online status, reboot survival, and a real Android job run cannot be demonstrated. |

## Exact workspace blocking evidence

```text
GitHub GET /repos/lisagorewitdecker/RealtimeAlgoChatApp/actions/runners: 200, runners: [] (2026-09-16)
java: command not found
adb: command not found
emulator: command not found
maestro: command not found
/dev/kvm: absent
```

## Companion automated checks at this revision

1. Android release preflight regression suite
   (`scripts/tests/check-android-release-prerequisites.test.sh`): **passed**,
   including the `aapt2` fixtures.
2. Android runner procedure regression suite
   (`scripts/tests/check-android-runner-procedure.test.sh`): **passed** (no
   unmanaged emulator launch; systemd emulator→runner boot ordering intact).
3. Android native large-text readiness suite
   (`scripts/tests/check-android-native-large-text-readiness.test.sh`):
   **passed**.
4. Shell syntax checks for the provisioning and preflight scripts: **passed**.

## Required next evidence

Complete these in order on the external host, then append a new tracked record
instead of editing this one:

1. Provision a Linux x86_64 KVM-capable host and follow the Linux runner
   procedure in
   [`native-large-text-device-check.md`](./native-large-text-device-check.md):
   create the `actions` account, install the SDK/AVD/Maestro as that user,
   download and verify the pinned runner `2.337.0` archive, register with the
   labels `self-hosted`, `linux`, `android`, `smallest-simulator`, and install
   both systemd services.
2. Reboot the host, confirm the emulator service reaches
   `sys.boot_completed=1` before the runner service starts, and confirm exactly
   one emulator process is running.
3. Verify through GitHub CLI (`gh api repos/<owner>/<repo>/actions/runners`)
   that the runner is `online` with all four required labels.
4. Run the Android release preflight on the host with a candidate APK and the
   required environment values, then trigger **Actions → Mobile release
   accessibility gate** and record the run URL, the runner name, and the
   successful Android job evidence in the new record.
