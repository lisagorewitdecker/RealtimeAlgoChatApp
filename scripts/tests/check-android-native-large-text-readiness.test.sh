#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
GATE="$WORKSPACE_ROOT/artifacts/chat-app/e2e/native-large-text/run.sh"
BASH_BIN="$(command -v bash)"
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"
LN_BIN="$(command -v ln)"
MKTEMP_BIN="$(command -v mktemp)"
MKDIR_BIN="$(command -v mkdir)"
RM_BIN="$(command -v rm)"

test_parent="$("$MKTEMP_BIN" -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
"$MKDIR_BIN" -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  "$RM_BIN" -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "Android native large-text readiness cleanup escaped its fixture directory" >&2
    return 1
  fi
  "$RM_BIN" -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

utilities="$test_root/utilities"
"$MKDIR_BIN" -p "$utilities" "$test_root/home"
for command in cat date dirname find mkdir sed tail tr wc; do
  "$LN_BIN" -s "$(command -v "$command")" "$utilities/$command"
done

make_stub() {
  local path="$1"
  local name="$2"
  cat >"$path/$name" <<EOF
#!${BASH_BIN}
exit 0
EOF
  chmod +x "$path/$name"
}

make_command_path() {
  local name="$1"
  local path="$test_root/$name"
  "$MKDIR_BIN" -p "$path"
  for utility in "$utilities"/*; do
    "$LN_BIN" -s "$utility" "$path/$(basename "$utility")"
  done
  make_stub "$path" maestro
  make_stub "$path" pnpm
  printf '%s\n' "$path"
}

make_adb_stub() {
  local path="$1"
  cat >"$path/adb" <<EOF
#!${BASH_BIN}
set -euo pipefail
case "\$*" in
  get-state)
    printf '%s\n' "\${ADB_STATE:-device}"
    ;;
  get-serialno)
    printf '%s\n' "\${ADB_SERIAL:-emulator-5554}"
    ;;
  "shell pm path "*)
    if [[ "\${ADB_CANDIDATE_INSTALLED:-1}" != "1" ]]; then
      exit 1
    fi
    printf '%s\n' "package:/data/app/release-candidate/base.apk"
    ;;
  "shell wm size")
    printf '%s\n' "Physical size: \${ADB_SIZE:-320x568}"
    ;;
  "shell wm density")
    printf '%s\n' "Physical density: \${ADB_DENSITY:-160}"
    ;;
  "shell settings get system user_rotation")
    printf '%s\n' "\${ADB_ROTATION:-0}"
    ;;
  "shell getprop ro.product.model")
    printf '%s\n' "Android SDK built for x86"
    ;;
  "shell getprop ro.build.version.release")
    printf '%s\n' "15"
    ;;
  "shell getprop ro.build.version.sdk")
    printf '%s\n' "35"
    ;;
  *)
    printf 'Unexpected adb invocation: %s\n' "\$*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$path/adb"
}

assert_contains() {
  local output="$1"
  local expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  local description="${3:-text}"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain %s: %s\n%s\n' \
      "$description" "$unexpected" "$output" >&2
    exit 1
  fi
}

assert_file_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then
    printf 'Expected no file at: %s\n' "$path" >&2
    exit 1
  fi
}

result_file_of() {
  cat "$test_root/$1-results/$2"
}

run_case() {
  local name="$1"
  local expected_status="$2"
  local path="$3"
  shift 3
  local output status
  local case_env=(
    PATH="$path:$utilities"
    HOME="$test_root/home"
    NATIVE_SMOKE_APP_ID=app-id-secret-sentinel
    NATIVE_SMOKE_BUILD_ID=build-id-secret-sentinel
    NATIVE_SMOKE_EMAIL=email-secret-sentinel
    NATIVE_SMOKE_PASSWORD=password-secret-sentinel
    NATIVE_SMOKE_RESULTS_DIR="$test_root/$name-results"
  )

  if output="$("$ENV_BIN" -i "${case_env[@]}" "$@" "$BASH_BIN" "$GATE" android 2>&1)"; then
    status=0
  else
    status=$?
  fi

  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' \
      "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name"
  printf '%s\n' "$output"

  for sentinel in \
    app-id-secret-sentinel \
    build-id-secret-sentinel \
    email-secret-sentinel \
    password-secret-sentinel; do
    assert_not_contains "$output" "$sentinel" "credential sentinel"
  done
}

missing_adb_path="$(make_command_path missing-adb)"
missing_adb_output="$(run_case missing-adb 2 "$missing_adb_path")"
assert_contains "$missing_adb_output" "adb is required for the Android smoke test."
assert_file_absent "$test_root/missing-adb-results/runner-metadata.txt"

unknown_serial_path="$(make_command_path unknown-serial)"
make_adb_stub "$unknown_serial_path"
unknown_serial_output="$(
  run_case unknown-serial 2 "$unknown_serial_path" ADB_SERIAL=unknown
)"
assert_contains \
  "$unknown_serial_output" \
  "Could not determine the connected Android device serial."
assert_file_absent "$test_root/unknown-serial-results/runner-metadata.txt"

candidate_missing_path="$(make_command_path candidate-missing)"
make_adb_stub "$candidate_missing_path"
candidate_missing_output="$(
  run_case candidate-missing 2 "$candidate_missing_path" ADB_CANDIDATE_INSTALLED=0
)"
assert_contains \
  "$candidate_missing_output" \
  "The release candidate is not installed on the connected Android device."
assert_file_absent "$test_root/candidate-missing-results/runner-metadata.txt"

oversized_path="$(make_command_path oversized)"
make_adb_stub "$oversized_path"
oversized_output="$(
  run_case oversized 2 "$oversized_path" ADB_SIZE=1080x1920 ADB_DENSITY=480
)"
assert_contains \
  "$oversized_output" \
  "Expected an Android emulator at or below 320x568 dp, found 360x640 dp."
assert_file_absent "$test_root/oversized-results/runner-metadata.txt"

landscape_path="$(make_command_path landscape)"
make_adb_stub "$landscape_path"
landscape_output="$(
  run_case landscape 2 "$landscape_path" ADB_ROTATION=1
)"
assert_contains \
  "$landscape_output" \
  "Expected the Android device in portrait orientation (user_rotation 0 or 2), found: 1."
assert_file_absent "$test_root/landscape-results/runner-metadata.txt"

happy_path="$(make_command_path happy)"
make_adb_stub "$happy_path"
happy_output="$(run_case happy 1 "$happy_path")"
assert_contains \
  "$happy_output" \
  "Running android native large-text smoke test; artifacts:"
assert_contains \
  "$happy_output" \
  "Expected at least 11 native screenshots, found 0."

runner_metadata="$(result_file_of happy runner-metadata.txt)"
assert_contains "$runner_metadata" "platform=android"
assert_contains "$runner_metadata" "run_mode=release-gate"
assert_contains "$runner_metadata" "device_serial=emulator-5554"
assert_contains "$runner_metadata" "device_model=Android SDK built for x86"
assert_contains "$runner_metadata" "android_release=15"
assert_contains "$runner_metadata" "android_api=35"
assert_contains "$runner_metadata" "screen_px=320x568"
assert_contains "$runner_metadata" "screen_dp=320x568"
assert_contains "$runner_metadata" "density_dpi=160"
assert_contains "$runner_metadata" "user_rotation=0"

pass_fail_record="$(result_file_of happy pass-fail-record.txt)"
assert_contains "$pass_fail_record" "platform=android"
assert_contains "$pass_fail_record" "run_mode=release-gate"
assert_contains "$pass_fail_record" "status=FAIL"
assert_contains "$pass_fail_record" "native_screenshot_count=0"

cleanup_test_fixtures
trap - EXIT

echo "Android native large-text readiness regression tests passed."