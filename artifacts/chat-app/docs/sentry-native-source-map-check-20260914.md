# Native Sentry source-map proof check

**Result: BLOCKED — no signed candidate, upload credential, GitHub release
environment, or prepared device runner was available**

This record is tracked because the prescribed `test-results/` directory is
gitignored. It records what was verified from the workspace and from the live
GitHub repository, and what the owner must still supply before crash reports
from real iPhone and Android builds can be proven readable. No simulator,
emulator, Expo Go session, or web preview was substituted, and no credential
value was read or written while producing it.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-14 17:11:00 |
| App | Chat App |
| Workspace revision | `1fa13a2` (local `development`) |
| SDK/runtime | Expo SDK 57 (`expo` `~57.0.22`; `@expo/cli` `57.0.24`; `react-native` `0.86.3`) |
| Crash reporting SDK | `@sentry/react-native` `7.11.0` (Expo SDK 57 bundled range: `~7.11.0`) |
| Sentry destination configured in `app.json` | organization `lisagorewitdecker-06`, project `react-native` |
| Candidate builds | N/A — no EAS project, build profile, or signed candidate exists |
| Device runners | N/A — no self-hosted runner is registered for this repository |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| `@sentry/react-native` matches the range Expo SDK 57 expects | PASS | `expo install --check` reported `Dependencies are up to date`; the installed `7.11.0` equals Expo's bundled `~7.11.0`. No alignment change was needed. |
| Native build preflight fails closed without the upload credential | PASS | `node scripts/build.js --native-build-preflight` exited 1 and named the missing `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE`, and `SENTRY_DIST` settings without printing any value. |
| Sentry pipeline exists at this revision | PASS | Native init, the hidden probe route, the Maestro flow, the build stamping, the event verifier, the evidence checker, and the workflow steps are all present (see companion checks below). |
| Signed iOS candidate built with source-map upload | BLOCKED | No `eas.json`, EAS project ID, or iOS bundle identifier exists in `artifacts/chat-app`; `eas` and `xcrun` are unavailable; no EAS or Expo token is present. |
| Signed Android candidate built with source-map upload | BLOCKED | Same as iOS; `android.package` is also undefined in `app.json`, and `adb`, `emulator`, and Java are unavailable. |
| `SENTRY_AUTH_TOKEN` reachable by the `mobile-release` GitHub environment | BLOCKED | The repository has no `mobile-release` environment (only `copilot`) and zero repository-level Actions secrets. |
| Candidate metadata recorded on GitHub | BLOCKED | Zero repository variables (`NATIVE_SMOKE_IOS_BUILD_ID`, `NATIVE_SMOKE_ANDROID_BUILD_ID`) and zero secrets (`NATIVE_SMOKE_*_SENTRY_RELEASE`, `NATIVE_SMOKE_*_SENTRY_DIST`, app IDs, test account). |
| Prepared iOS and Android runners | BLOCKED | The repository's self-hosted runner list is empty; no runner carries the `smallest-simulator` labels. |
| Pipeline present on GitHub's `development` branch | BLOCKED | GitHub `development` (`eae587d`) predates the crash-reporting work: the verifier, probe route, native init, build stamping, evidence checker, and the Maestro flow are absent there, and its `mobile-release.yml` (375 lines, no Sentry steps) differs from the workspace copy (898 lines). The workflow has zero recorded runs. |
| iOS Sentry event with a readable `createNativeSourceMapProbeError` frame | BLOCKED | No candidate was built, so no probe was sent and the verifier was not run. |
| Android Sentry event with a readable `createNativeSourceMapProbeError` frame | BLOCKED | Same as iOS. |
| Sanitized `sentry-source-map-evidence.json` for both platforms | BLOCKED | No release-gate run directory exists under `test-results/native-large-text/<platform>/`. |

## Exact workspace blocking evidence

```text
xcrun: command not found
xcodebuild: command not found
adb: command not found
emulator: command not found
maestro: command not found
eas: command not found
java: command not found
/dev/bus/usb: absent
artifacts/chat-app/.expo/devices.json: {"devices":[]}
artifacts/chat-app/eas.json: absent
app.json: no extra.eas.projectId, ios.bundleIdentifier, or android.package
SENTRY_DSN: set (workspace secret; value not read)
SENTRY_AUTH_TOKEN, EAS_TOKEN, EXPO_TOKEN: unset
SENTRY_RELEASE, SENTRY_DIST, EAS_BUILD_ID, SENTRY_BUILD_ID: unset
NATIVE_SMOKE_* variables: none present
```

## Live GitHub repository state

Checked through the repository API with the owner's GitHub connection. Only
names, counts, and statuses were read; no secret or variable value was
requested.

```text
default branch: development @ eae587d (workspace development is 230 commits ahead)
environments: copilot            (mobile-release: not found)
repository Actions secrets: 0    repository Actions variables: 0
self-hosted runners: 0
runs of .github/workflows/mobile-release.yml: 0
```

## Automated companion checks at this revision

These passed at the same revision; they prove the pipeline fails closed and
validates evidence correctly, not that a real device event was readable:

1. Sentry event verifier contract (`scripts/tests/verify-sentry-native-event.test.mjs`): **5 tests passed** — accepts only a matching release, dist, platform, candidate build ID, and a mapped in-app probe frame with a line and column; rejects other releases, minified bundle frames, and unrelated mapped frames; retries transient API failures.
2. Mobile release summary contract: **14 tests passed**.
3. Mobile release caller contract: **6 tests passed**.
4. Native evidence completeness regression suite: **passed** (candidate-bound Sentry evidence is required for a complete platform).
5. Chat App build preflight (`scripts/build.test.js`): **9 tests passed**.
6. Chat App `sentry.test.ts` and `buildIdentity.test.ts`: **2 suites, 7 tests passed** (Expo Go gating, release/dist stamping, probe tagging).

## Required next evidence

Complete these in order, then append a new tracked record instead of editing
this one:

1. Bring GitHub `development` up to date with the workspace so the workflow,
   verifier, and probe route exist where Actions runs them (tracked separately
   with the GitHub synchronization work).
2. Configure EAS for the Chat App from an account that owns the app: create
   `eas.json` with a release build profile, set `ios.bundleIdentifier`,
   `android.package`, and the EAS project ID, and give the release profile
   `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE`, and `SENTRY_DIST` as EAS
   environment values. EAS supplies `EAS_BUILD_ID`. The token needs release
   upload and event read access for organization `lisagorewitdecker-06`,
   project `react-native`; it must never be committed, stored as a Replit
   secret, given an `EXPO_PUBLIC_` name, or pasted into chat or logs.
3. Build one signed iOS and one signed Android candidate with that profile and
   record each build's EAS build ID together with the release and distribution
   values used (all non-secret).
4. Create the `mobile-release` GitHub environment, add the secrets listed in
   [`native-large-text-device-check.md`](./native-large-text-device-check.md)
   (including `SENTRY_AUTH_TOKEN` and the per-platform release and
   distribution values), and set the repository variables
   `NATIVE_SMOKE_IOS_BUILD_ID` and `NATIVE_SMOKE_ANDROID_BUILD_ID`.
5. Register the prepared iOS and Android runners with the labels documented in
   the same procedure, with each candidate installed under the app ID given to
   the workflow.
6. Run **Actions → Mobile release accessibility gate**, confirm the Sentry
   trigger and verification steps pass on both platforms, download both
   `sentry-source-map-evidence.json` files, run
   `pnpm run validate:native-large-text-evidence`, and record the run URL,
   candidate build IDs, release and distribution values, and the mapped
   `createNativeSourceMapProbeError` file and line for each platform in the new
   record.
