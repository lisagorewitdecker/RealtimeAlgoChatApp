#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-native-large-text-evidence.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" <<<"$output"; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

write_valid_run() {
  local root="$1"
  local platform="$2"
  local run_dir="$root/$platform/20260909T120000Z"
  local index

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"
  printf 'build-%s\n' "$platform" > "$run_dir/candidate-build-id.txt"
  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
candidate_build_id=build-ios
device=iPhone SE (3rd generation)
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
candidate_build_id=build-android
device_serial=emulator-5554
device_model=Smallest supported emulator
android_release=16
android_api=36
screen_dp=320x568
density_dpi=160
user_rotation=0
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
status=PASS
EOF
  printf '{}\n' > "$run_dir/native-info.json"
  printf '# Native branding validation\n\n- Status: **PASS**\n' > "$run_dir/native-branding-check.md"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/maestro-results.xml"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/sentry-maestro-results.xml"
  cat > "$run_dir/sentry-trigger.txt" <<EOF
platform=$platform
candidate_build_id=build-$platform
marker=run-1234-$platform
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{
  "status": "PASS",
  "eventId": "0123456789abcdef0123456789abcdef",
  "platform": "$platform",
  "candidateBuildId": "build-$platform",
  "marker": "run-1234-$platform",
  "release": "chat-app@1.0.0+abc123",
  "dist": "42",
  "readableFrame": {
    "filename": "artifacts/chat-app/lib/sentry.ts",
    "function": "createNativeSourceMapProbeError",
    "line": 55,
    "column": 10
  }
}
EOF
  for index in $(seq 1 11); do
    printf 'png-%s\n' "$index" > "$run_dir/screenshots/screen-$index.png"
  done
  for index in 1 2; do
    printf 'call-%s\n' "$index" > "$run_dir/call-surface/call-$index.png"
  done
}

blocked_root="$TEST_ROOT/blocked"
mkdir -p "$blocked_root/ios" "$blocked_root/android"
printf 'Result: BLOCKED\n' > "$blocked_root/ios/runner-check.txt"
printf 'Result: BLOCKED\n' > "$blocked_root/android/runner-check.txt"
if blocked_output="$(bash "$CHECKER" "$blocked_root" 2>&1)"; then
  echo "blocked diagnostics case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$blocked_output" "[ios] Only runner-check.txt is present"
assert_contains "$blocked_output" "[android] Only runner-check.txt is present"
assert_contains "$blocked_output" "blocked runner diagnostics, not reviewed device evidence"

incomplete_root="$TEST_ROOT/incomplete"
write_valid_run "$incomplete_root" ios
write_valid_run "$incomplete_root" android
rm "$incomplete_root/android/20260909T120000Z/runner-metadata.txt"
: > "$incomplete_root/ios/20260909T120000Z/call-surface/call-1.png"
if incomplete_output="$(bash "$CHECKER" "$incomplete_root" 2>&1)"; then
  echo "incomplete evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$incomplete_output" "[android] Missing runner metadata and device details"
assert_contains "$incomplete_output" "[ios] Found 1 empty call-surface screenshot file(s)"

unmapped_root="$TEST_ROOT/unmapped"
write_valid_run "$unmapped_root" ios
write_valid_run "$unmapped_root" android
node --input-type=module - "$unmapped_root/android/20260909T120000Z/sentry-source-map-evidence.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const evidence = JSON.parse(readFileSync(path, "utf8"));
evidence.readableFrame.filename = "app:///index.android.bundle";
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
if unmapped_output="$(bash "$CHECKER" "$unmapped_root" 2>&1)"; then
  echo "unmapped Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$unmapped_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$unmapped_output" "readable source-mapped frame is missing"

wrong_function_root="$TEST_ROOT/wrong-function"
write_valid_run "$wrong_function_root" ios
write_valid_run "$wrong_function_root" android
node --input-type=module - "$wrong_function_root/android/20260909T120000Z/sentry-source-map-evidence.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const evidence = JSON.parse(readFileSync(path, "utf8"));
evidence.readableFrame.function = "someOtherMappedFunction";
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
if wrong_function_output="$(bash "$CHECKER" "$wrong_function_root" 2>&1)"; then
  echo "wrong-function Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$wrong_function_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$wrong_function_output" "readable source-mapped frame is missing"

valid_root="$TEST_ROOT/valid"
write_valid_run "$valid_root" ios
write_valid_run "$valid_root" android
valid_output="$(bash "$CHECKER" "$valid_root" 2>&1)"
assert_contains "$valid_output" "passed for iOS and Android"

echo "Native large-text evidence completeness regression tests passed."