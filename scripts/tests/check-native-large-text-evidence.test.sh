#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RESULTS_ROOT="$TMP_DIR/test-results/native-large-text"
INVALID_RESULTS_ROOT="$TMP_DIR/test-results-invalid/native-large-text"
SUMMARY_PATH="$TMP_DIR/summary.md"
STDOUT_PATH="$TMP_DIR/stdout.log"
STDERR_PATH="$TMP_DIR/stderr.log"
INVALID_SUMMARY_PATH="$TMP_DIR/invalid-summary.md"
INVALID_STDOUT_PATH="$TMP_DIR/invalid-stdout.log"
INVALID_STDERR_PATH="$TMP_DIR/invalid-stderr.log"
IOS_BUILD_ID="ios-candidate-build-12345"
ANDROID_BUILD_ID="android-candidate-build-67890"

create_platform_fixture() {
  local results_root="$1"
  local platform="$2"
  local build_id="$3"
  local run_dir="$results_root/$platform/2026-09-15T15-03-49Z"
  local marker="${platform}-marker"
  local frame_file="app/${platform}/probe.ts"

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"

  printf '%s\n' "$build_id" > "$run_dir/candidate-build-id.txt"
  cat > "$run_dir/pass-fail-record.txt" <<EOF
status=PASS
run_mode=release-gate
EOF

  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
candidate_build_id=$build_id
recorded_at_utc=2026-09-15T15:03:49Z
device=iPhone 15
EOF
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
candidate_build_id=$build_id
recorded_at_utc=2026-09-15T15:03:49Z
device_serial=emulator-5554
device_model=Pixel 8
android_release=15
android_api=35
screen_dp=412x915
density_dpi=420
user_rotation=0
EOF
  fi

  printf '{}\n' > "$run_dir/native-info.json"
  cat > "$run_dir/native-branding-check.md" <<EOF
## ${platform} native branding

- Status: **PASS**
EOF
  printf '<testsuite name="%s"></testsuite>\n' "$platform" > "$run_dir/maestro-results.xml"
  printf '<testsuite name="%s-sentry"></testsuite>\n' "$platform" > "$run_dir/sentry-maestro-results.xml"
  cat > "$run_dir/sentry-trigger.txt" <<EOF
platform=$platform
candidate_build_id=$build_id
marker=$marker
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{"status":"PASS","platform":"$platform","candidateBuildId":"$build_id","marker":"$marker","eventId":"event-$platform","release":"release-$platform","dist":"1","readableFrame":{"filename":"$frame_file","function":"createNativeSourceMapProbeError","line":1,"column":1}}
EOF

  for index in $(seq 1 11); do
    printf 'png-%s\n' "$index" > "$run_dir/screenshots/$index.png"
  done
  for index in $(seq 1 2); do
    printf 'png-%s\n' "$index" > "$run_dir/call-surface/$index.png"
  done
}

create_platform_fixture "$RESULTS_ROOT" ios "$IOS_BUILD_ID"
create_platform_fixture "$RESULTS_ROOT" android "$ANDROID_BUILD_ID"

GITHUB_STEP_SUMMARY="$SUMMARY_PATH" \
  bash "$ROOT_DIR/scripts/check-native-large-text-evidence.sh" "$RESULTS_ROOT" \
  >"$STDOUT_PATH" 2>"$STDERR_PATH"

grep -Fq "## iOS native large-text evidence" "$SUMMARY_PATH"
grep -Fq "## Android native large-text evidence" "$SUMMARY_PATH"
grep -Fq -- "- Status: **PASS**" "$SUMMARY_PATH"
grep -Fq "Native large-text evidence completeness check passed for iOS and Android." "$STDOUT_PATH"

if grep -Fq "$IOS_BUILD_ID" "$SUMMARY_PATH" || grep -Fq "$IOS_BUILD_ID" "$STDOUT_PATH" || grep -Fq "$IOS_BUILD_ID" "$STDERR_PATH"; then
  echo "iOS candidate build ID leaked into summary or logs." >&2
  exit 1
fi

if grep -Fq "$ANDROID_BUILD_ID" "$SUMMARY_PATH" || grep -Fq "$ANDROID_BUILD_ID" "$STDOUT_PATH" || grep -Fq "$ANDROID_BUILD_ID" "$STDERR_PATH"; then
  echo "Android candidate build ID leaked into summary or logs." >&2
  exit 1
fi

BROKEN_RESULTS_ROOT="$TMP_DIR/test-results/native-large-text-mismatched-runner-metadata"
BROKEN_SUMMARY_PATH="$TMP_DIR/broken-summary.md"
BROKEN_STDOUT_PATH="$TMP_DIR/broken-stdout.log"
BROKEN_STDERR_PATH="$TMP_DIR/broken-stderr.log"

create_platform_fixture "$INVALID_RESULTS_ROOT" ios "$IOS_BUILD_ID"
create_platform_fixture "$INVALID_RESULTS_ROOT" android "$ANDROID_BUILD_ID"
cat > "$INVALID_RESULTS_ROOT/ios/2026-09-15T15-03-49Z/candidate-build-id.txt" <<EOF
$IOS_BUILD_ID
unexpected-second-id
EOF

set +e
GITHUB_STEP_SUMMARY="$INVALID_SUMMARY_PATH" \
  bash "$ROOT_DIR/scripts/check-native-large-text-evidence.sh" "$INVALID_RESULTS_ROOT" \
  >"$INVALID_STDOUT_PATH" 2>"$INVALID_STDERR_PATH"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "Expected multi-line candidate-build-id.txt to fail validation." >&2
  exit 1
fi

grep -Fq "contains multiple normalized lines" "$INVALID_STDERR_PATH"

create_platform_fixture "$BROKEN_RESULTS_ROOT" ios "$IOS_BUILD_ID"
create_platform_fixture "$BROKEN_RESULTS_ROOT" android "$ANDROID_BUILD_ID"
perl -0pi -e 's/candidate_build_id=\Q'"$IOS_BUILD_ID"'\E/candidate_build_id=ios-candidate-build-mismatch/' \
  "$BROKEN_RESULTS_ROOT/ios/2026-09-15T15-03-49Z/runner-metadata.txt"

if GITHUB_STEP_SUMMARY="$BROKEN_SUMMARY_PATH" \
  bash "$ROOT_DIR/scripts/check-native-large-text-evidence.sh" "$BROKEN_RESULTS_ROOT" \
  >"$BROKEN_STDOUT_PATH" 2>"$BROKEN_STDERR_PATH"; then
  echo "Expected runner metadata candidate_build_id mismatch to fail." >&2
  exit 1
fi

grep -Fq "Runner metadata candidate_build_id does not match the tested candidate" "$BROKEN_STDERR_PATH"
