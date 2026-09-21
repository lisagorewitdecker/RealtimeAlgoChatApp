# Native Sentry source-map proof check — 2026-09-20

**Result: BLOCKED — no signed candidates, Sentry release credentials, or
prepared native runners were available**

This dated record captures the current release-candidate probe attempt. It does
not substitute a simulator, emulator, Expo Go session, or web preview for the
required native release evidence. No credential value was read or written.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-20 23:17:35 |
| App | Chat App |
| Workspace revision | `2937e358685c00e4ef7b34fee8fe16dfa71a3816` |
| GitHub `main` revision observed | `6eed1566cb6d2fbd4d978ad2f9a75ac564a21095` |
| Crash reporting SDK | `@sentry/react-native` `^7.11.0`; `@sentry/cli` `2.58.4` is declared directly by the app |
| Sentry destination configured in `app.json` | organization `lisagorewitdecker-06`, project `react-native` |
| Candidate builds | N/A — no `eas.json`, EAS project identifiers, or installed candidate build IDs are available locally |
| Local native runners | N/A — `xcrun`, `adb`, `emulator`, Java, Maestro, and EAS CLI are unavailable; `/dev/bus/usb` is absent; Expo reports no devices |
| Hosted native runners | Not confirmed — the GitHub runner listing request was rate-limited; no native job or artifact was found in the inspected release runs |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Sentry event verifier contract | PASS | `scripts/tests/verify-sentry-native-event.test.mjs`: 32 tests passed |
| Trigger writer/checker contract | PASS | `scripts/tests/sentry-trigger-contract.test.mjs`: 2 tests passed |
| Conditional native upload policy | PASS | `pnpm --filter @workspace/chat-app run test:sentry-upload-policy`: 11 tests passed |
| Native evidence completeness regression suite | PASS | `scripts/tests/check-native-large-text-evidence.test.sh` passed |
| Signed iOS candidate built with source-map upload | **BLOCKED** | No signed candidate, EAS configuration, native tooling, or prepared iOS runner is available |
| Signed Android candidate built with source-map upload | **BLOCKED** | No signed candidate, EAS configuration, native tooling, or prepared Android runner is available |
| Sentry release credentials in the hosted `mobile-release` environment | **BLOCKED** | The environment currently exposes only `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `DATABASE_URL`, `E2E_API_URL`, and `E2E_CHAT_URL`; no Sentry credential name is present |
| Candidate IDs in hosted release configuration | **BLOCKED** | No repository Actions variables are configured and the `mobile-release` environment has no variables |
| Hosted iOS source-map event with a readable frame | **BLOCKED** | No qualifying native job ran, so no controlled iOS event or evidence artifact exists |
| Hosted Android source-map event with a readable frame | **BLOCKED** | No qualifying native job ran, so no controlled Android event or evidence artifact exists |
| Candidate-bound evidence for both platforms | **BLOCKED** | `test-results/native-large-text/ios/` and `android/` contain only `runner-check.txt`, not timestamped candidate evidence directories |

## Exact workspace blocking evidence

```text
xcrun: unavailable
adb: unavailable
emulator: unavailable
java: unavailable
maestro: unavailable
eas: unavailable
/dev/bus/usb: absent
artifacts/chat-app/.expo/devices.json: {"devices":[]}
artifacts/chat-app/eas.json: absent
NATIVE_SMOKE_* variables: none present
test-results/native-large-text/ios/: runner-check.txt only
test-results/native-large-text/android/: runner-check.txt only
```

## Hosted GitHub state

The repository API was queried through the configured GitHub connection using
names, counts, statuses, and run metadata only:

```text
repository: lisagorewitdecker/RealtimeAlgoChatApp
mobile-release environment: present
mobile-release environment secret names: 5 (Clerk, database, and E2E names only)
mobile-release environment variable names: 0
repository Actions secret names: 0
repository Actions variable names: 0
mobile-release workflow: active
inspected run 35541023922: pull_request, success, preview jobs only
inspected run 35533961601: pull_request, success, preview jobs only
inspected run 35541023922 native jobs: skipped
inspected run 35533961601 native jobs: skipped
inspected release-run artifacts: 0
latest inspected run 35541428347: pull_request, action_required, no jobs or artifacts returned
```

A successful pull-request workflow with native jobs skipped is not evidence that
either signed release candidate produced a readable Sentry event.

## Evidence validator result

Running `bash scripts/check-native-large-text-evidence.sh` failed for the
expected two blocking issues:

```text
[ios] Only runner-check.txt is present ... blocked runner diagnostics, not reviewed device evidence
[android] Only runner-check.txt is present ... blocked runner diagnostics, not reviewed device evidence
Native large-text evidence completeness check FAILED with 2 issue(s).
```

This is the intended fail-closed behavior. The diagnostic files must not be
copied into candidate evidence directories or used to create review records.

## Required next evidence

1. Configure the Chat App's EAS release project and native identifiers,
   including the iOS bundle identifier, Android package, project ID, and release
   profile.
2. Build one iOS and one Android signed candidate through the approved release
   flow with `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE`, and
   `SENTRY_DIST`; retain each candidate's non-secret build ID, release, and
   distribution values.
3. Add the masked Sentry credential and the documented smoke-account,
   candidate-release, candidate-distribution, and app-ID values to the GitHub
   `mobile-release` environment. Add the two candidate build IDs as repository
   variables.
4. Provide prepared iOS and Android native runners with the release candidates
   installed and the required tooling and smoke account.
5. Run the non-pull-request `mobile-release` gate on the synchronized workflow
   revision. It must send the controlled probe on both platforms, verify the
   matching release, distribution, platform, candidate build ID, and marker, and
   find `createNativeSourceMapProbeError` as an in-app frame with a positive
   file, line, and column.
6. Preserve both uploaded `sentry-source-map-evidence.json` files and append a
   new dated record containing the qualifying run URL, candidate IDs, release
   and distribution values, and the mapped file and line for each platform.