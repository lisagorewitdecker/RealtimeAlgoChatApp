# Native Sentry source-map proof check — 2026-09-17

**Result: BLOCKED — no signed candidates, release credentials, prepared native
runners, or qualifying hosted release run were available**

This is a new dated record. The earlier
`sentry-native-source-map-check-20260914.md` remains unchanged as the audit for
the older repository state. This check does not substitute a simulator,
emulator, Expo Go session, or web preview for the required native release
evidence, and no credential value was read or written.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-17 14:23:34 |
| App | Chat App |
| Workspace revision | `fc67fdfa66729f9ad4945b304d81dc8dbb3f660a` |
| Crash reporting SDK | `@sentry/react-native` `^7.11.0`; `@sentry/cli` `2.58.4` is declared directly by the app |
| Sentry destination configured in `app.json` | organization `lisagorewitdecker-06`, project `react-native` |
| Candidate builds | N/A — `artifacts/chat-app/eas.json` is absent and no candidate build IDs are configured |
| Local native runners | N/A — no `xcrun`, `adb`, `maestro`, `java`, or `eas`; no USB bus; Expo device list is empty |
| Hosted native runners | N/A — the GitHub self-hosted runner list is empty |

## Acceptance result

| Check | Status | Evidence |
| --- | --- | --- |
| Sentry event verifier contract | PASS | `scripts/tests/verify-sentry-native-event.test.mjs`: 25 tests passed |
| Native build preflight contract | PASS | `artifacts/chat-app/scripts/build.test.js`: 9 tests passed |
| Conditional native upload policy | PASS | `pnpm --filter @workspace/chat-app run test:sentry-upload-policy`: 11 tests passed |
| Signed iOS candidate built with source-map upload | **BLOCKED** | No EAS project configuration, iOS bundle identifier, signed candidate, or local iOS build tooling is available |
| Signed Android candidate built with source-map upload | **BLOCKED** | No EAS project configuration, Android package, signed candidate, or local Android build tooling is available |
| `SENTRY_AUTH_TOKEN` in the hosted `mobile-release` environment | **BLOCKED** | The environment exists, but its secret-name listing is empty; no secret value was requested |
| Candidate metadata in the hosted `mobile-release` environment | **BLOCKED** | The environment variable-name listing is empty; no iOS or Android candidate IDs are configured |
| Prepared native runners | **BLOCKED** | GitHub reports no self-hosted runners; the local workspace has no native runner |
| Hosted iOS source-map event with a readable frame | **BLOCKED** | No native job ran, so no controlled iOS probe event exists to inspect |
| Hosted Android source-map event with a readable frame | **BLOCKED** | No native job ran, so no controlled Android probe event exists to inspect |
| Candidate-bound `sentry-source-map-evidence.json` for both platforms | **BLOCKED** | The qualifying native jobs have not produced evidence artifacts |

## Exact workspace blocking evidence

```text
xcrun: command not found
adb: command not found
maestro: command not found
java: command not found
eas: command not found
/dev/bus/usb: absent
artifacts/chat-app/.expo/devices.json: {"devices":[]}
artifacts/chat-app/eas.json: absent
app.json: no extra.eas.projectId, ios.bundleIdentifier, or android.package
environment variable names observed: SENTRY_DSN only
SENTRY_AUTH_TOKEN, EAS_TOKEN, EXPO_TOKEN: not present in the workspace environment
SENTRY_RELEASE, SENTRY_DIST, EAS_BUILD_ID, SENTRY_BUILD_ID: not present
NATIVE_SMOKE_* variables: none present
```

## Hosted GitHub state

The repository API was queried through the configured GitHub connection using
names, counts, statuses, and run metadata only:

```text
environment: mobile-release (present)
mobile-release environment secret names: 0
mobile-release environment variable names: 0
self-hosted runners: 0
latest inspected run: 35230571576
latest inspected run event: pull_request
latest inspected run conclusion: success
latest inspected iOS native smoke job: skipped
latest inspected Android native smoke job: skipped
latest inspected run artifacts: 0
```

The other recent successful runs inspected were also pull-request checks with
the native smoke jobs skipped and no artifacts. A successful pull-request
workflow with both native jobs skipped is not evidence that a signed native
candidate produced a readable Sentry event.

## Current workspace note

The checkout also has an unresolved merge conflict in
`.github/workflows/mobile-release.yml` from separate hosted-summary work. This
record does not resolve or claim that unrelated change.

## Required next evidence

1. Configure the Chat App's EAS release project and native identifiers, including
   an iOS bundle identifier, Android package, project ID, and release profile.
2. Build one iOS and one Android signed candidate through the approved Expo/EAS
   release flow with `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE`, and
   `SENTRY_DIST`; retain each candidate's non-secret build ID, release, and
   distribution values. The token must remain outside the repository and
   Replit Secrets.
3. Add the masked `SENTRY_AUTH_TOKEN` and the required smoke-account,
   candidate-release, candidate-distribution, app-ID, API, Clerk, and database
   values to the GitHub `mobile-release` environment. Add the two candidate
   build IDs as the documented repository variables.
4. Provide the prepared iOS and Android native runners required by the release
   workflow: a booted iPhone SE (3rd generation) simulator and a small Android
   emulator, each with the release candidate installed, plus the required
   tooling and smoke account.
5. Run the non-pull-request `mobile-release` gate on the synchronized workflow
   revision. It must send the controlled probe on both platforms, verify the
   matching release, distribution, platform, candidate build ID, and probe
   marker, and find `createNativeSourceMapProbeError` as an in-app frame with a
   positive file/line/column.
6. Preserve both uploaded `sentry-source-map-evidence.json` files and append a
   new dated record containing the qualifying run URL, candidate IDs, release
   and distribution values, and the mapped file and line for each platform.
