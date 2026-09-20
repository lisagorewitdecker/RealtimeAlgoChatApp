#!/usr/bin/env bash

# Write the complete controlled evidence layout used by local and hosted
# tamper regressions. Keep this fixture in sync with the native evidence
# producers so the strict checker exercises the same required fields in both
# environments.
write_native_large_text_evidence_fixture() {
  if (($# < 2 || $# > 6)); then
    echo "Usage: write_native_large_text_evidence_fixture ROOT PLATFORM [BUILD_ID] [RUN_TIMESTAMP] [RECORDED_AT_UTC] [PASS_RECORDED_AT_UTC]" >&2
    return 2
  fi

  local root="$1"
  local platform="$2"
  local build_id="${3:-build-$platform}"
  local run_timestamp="${4:-20260909T120000Z}"
  local recorded_at_utc="${5:-2026-09-09T12:00:00Z}"
  local pass_recorded_at_utc="${6:-2026-09-09T12:30:00Z}"
  local run_dir="$root/$platform/$run_timestamp"
  local index

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"
  printf '%s\n' "$build_id" > "$run_dir/candidate-build-id.txt"
  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
run_mode=release-gate
candidate_build_id=$build_id
app_id=com.example.chat
device=iPhone SE (3rd generation)
device_udid=00000000-0000-0000-0000-000000000000
recorded_at_utc=$recorded_at_utc
EOF
    printf '# iOS native readiness\n\n- Status: **READY**\n' > "$run_dir/ios-readiness.md"
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
run_mode=release-gate
candidate_build_id=$build_id
app_id=com.example.chat
device_serial=emulator-5554
device_model=Smallest supported emulator
android_release=16
android_api=36
screen_px=320x568
screen_dp=320x568
density_dpi=160
user_rotation=0
recorded_at_utc=$recorded_at_utc
EOF
    printf 'applicationLabel=Chat\npermissions=android.permission.INTERNET\n' > "$run_dir/android-badging.txt"
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
run_mode=release-gate
candidate_build_id=$build_id
status=PASS
native_screenshot_count=11
call_surface_screenshot_count=2
recorded_at_utc=$pass_recorded_at_utc
EOF
  printf '{}\n' > "$run_dir/native-info.json"
  printf '# Native branding validation\n\n- Status: **PASS**\n' > "$run_dir/native-branding-check.md"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/maestro-results.xml"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/sentry-maestro-results.xml"
  cat > "$run_dir/sentry-trigger.txt" <<EOF
platform=$platform
candidate_build_id=$build_id
marker=run-1234-$platform
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{
  "status": "PASS",
  "eventId": "0123456789abcdef0123456789abcdef",
  "platform": "$platform",
  "candidateBuildId": "$build_id",
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