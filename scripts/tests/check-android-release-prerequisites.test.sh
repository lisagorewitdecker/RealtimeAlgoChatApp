#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PREFLIGHT="$WORKSPACE_ROOT/scripts/check-android-release-prerequisites.sh"
BASH_BIN="$(command -v bash)"
ENV_BIN="$(command -v env)"
MKDIR_BIN="$(command -v mkdir)"
LN_BIN="$(command -v ln)"
MKTEMP_BIN="$(command -v mktemp)"
RM_BIN="$(command -v rm)"
GREP_BIN="$(command -v grep)"

test_parent="$("$MKTEMP_BIN" -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
"$MKDIR_BIN" -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  "$RM_BIN" -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "Android preflight test cleanup escaped its fixture directory" >&2
    return 1
  fi
  "$RM_BIN" -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT
"$MKDIR_BIN" -p "$test_root/sdk" "$test_root/home"

make_utilities() {
  local directory="$1"
  local include_timeout="$2"
  "$MKDIR_BIN" -p "$directory"
  for command in uname tr tail sed head; do
    "$LN_BIN" -s "$(command -v "$command")" "$directory/$command"
  done
  if [[ "$include_timeout" == "yes" ]]; then
    "$LN_BIN" -s "$(command -v timeout)" "$directory/timeout"
  fi
}

make_runner_commands() {
  local directory="$1"
  local java_version="$2"
  "$MKDIR_BIN" -p "$directory"
  for command in sdkmanager avdmanager emulator pnpm maestro aapt2; do
    printf '#!%s\nexit 0\n' "$BASH_BIN" >"$directory/$command"
    chmod +x "$directory/$command"
  done
  cat >"$directory/java" <<EOF
#!${BASH_BIN}
echo 'openjdk version "${java_version}"' >&2
EOF
  chmod +x "$directory/java"
  cat >"$directory/adb" <<'EOF'
PLACEHOLDER
set -euo pipefail
case "${1:-}" in
  wait-for-device) exit 0 ;;
  get-state) printf 'device\n' ;;
  shell)
    case "${2:-}" in
      wm)
        if [[ "${3:-}" == "size" ]]; then
          printf 'Physical size: 320x568\n'
        else
          printf 'Physical density: 160\n'
        fi
        ;;
      settings) printf '0\n' ;;
      pm) printf 'package:/data/app/com.example/base.apk\n' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
EOF
  sed -i "1s|PLACEHOLDER|#!${BASH_BIN}|" "$directory/adb"
  chmod +x "$directory/adb"
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
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain secret sentinel: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

run_case() {
  local name="$1"
  local expected_status="$2"
  local path="$3"
  shift 3
  local output status
  if output="$("$ENV_BIN" -i \
    PATH="$path" \
    HOME="$test_root/home" \
    "$@" \
    "$BASH_BIN" "$PREFLIGHT" 2>&1
  )"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name"
  printf '%s\n' "$output"
}

ready_path="$test_root/ready"
ready_commands="$test_root/ready-commands"
make_utilities "$ready_path" yes
make_runner_commands "$ready_commands" "17.0.13"
ready_path="$ready_commands:$ready_path"

ready_output="$(
  run_case ready 0 "$ready_path" \
    GITHUB_STEP_SUMMARY="$test_root/ready-summary.md" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains "$ready_output" "ANDROID_RELEASE_PREFLIGHT=READY"
assert_not_contains "$ready_output" "secret-value-must-not-print"
assert_contains "$(<"$test_root/ready-summary.md")" "Status: **READY**"

old_java_output="$(
  old_java_commands="$test_root/old-java-commands"
  make_runner_commands "$old_java_commands" "11.0.24"
  run_case old-java 2 "$old_java_commands:$ready_path" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains "$old_java_output" "Java 17 or newer is required; found Java 11.0.24."
assert_not_contains "$old_java_output" "secret-value-must-not-print"

missing_values_output="$(
  run_case missing-release-values 2 "$ready_path" \
    GITHUB_STEP_SUMMARY="$test_root/missing-values-summary.md" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
for missing_value in \
  NATIVE_SMOKE_APP_ID \
  NATIVE_SMOKE_BUILD_ID \
  NATIVE_SMOKE_EMAIL; do
  assert_contains "$missing_values_output" "Required release value is missing: $missing_value"
done
assert_not_contains "$missing_values_output" "secret-value-must-not-print"
assert_contains "$(<"$test_root/missing-values-summary.md")" "Status: **BLOCKED**"

missing_sdk_output="$(
  run_case missing-sdk 2 "$ready_path" \
    ANDROID_SDK_ROOT="$test_root/missing-sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains "$missing_sdk_output" "Android SDK directory does not exist:"
assert_not_contains "$missing_sdk_output" "secret-value-must-not-print"

invalid_timeout_output="$(
  run_case invalid-timeout 2 "$ready_path" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    ANDROID_PREFLIGHT_DEVICE_TIMEOUT_SECONDS=0 \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains \
  "$invalid_timeout_output" \
  "ANDROID_PREFLIGHT_DEVICE_TIMEOUT_SECONDS must be a positive integer."
if "$GREP_BIN" -Fq -- "No ready Android emulator" <<<"$invalid_timeout_output"; then
  printf 'Invalid timeout should not be reported as a device timeout.\n%s\n' \
    "$invalid_timeout_output" >&2
  exit 1
fi

missing_timeout_utilities="$test_root/no-timeout"
make_utilities "$missing_timeout_utilities" no
missing_timeout_output="$(
  run_case missing-timeout 2 "$ready_commands:$missing_timeout_utilities" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains "$missing_timeout_output" "Required command is missing: timeout"
if "$GREP_BIN" -Fq -- "No ready Android emulator" <<<"$missing_timeout_output"; then
  printf 'Missing timeout should not be reported as a device timeout.\n%s\n' "$missing_timeout_output" >&2
  exit 1
fi

large_device_commands="$test_root/large-device-commands"
make_runner_commands "$large_device_commands" "17.0.13"
sed -i 's/320x568/480x800/' "$large_device_commands/adb"
large_device_output="$(
  run_case large-device 2 "$large_device_commands:$ready_path" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains \
  "$large_device_output" \
  "The Android runner must use an emulator at or below 320x568 dp; found 480x800 dp."
assert_not_contains "$large_device_output" "secret-value-must-not-print"

wrong_orientation_commands="$test_root/wrong-orientation-commands"
make_runner_commands "$wrong_orientation_commands" "17.0.13"
sed -i "s/printf '0\\\\n'/printf '1\\\\n'/" "$wrong_orientation_commands/adb"
wrong_orientation_output="$(
  run_case wrong-orientation 2 "$wrong_orientation_commands:$ready_path" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains \
  "$wrong_orientation_output" \
  "The Android runner must be in portrait orientation; found user_rotation=1."
assert_not_contains "$wrong_orientation_output" "secret-value-must-not-print"

missing_app_commands="$test_root/missing-app-commands"
make_runner_commands "$missing_app_commands" "17.0.13"
sed -i "/pm) printf/c\\       pm) exit 1 ;;" \
  "$missing_app_commands/adb"
missing_app_output="$(
  run_case missing-app 2 "$missing_app_commands:$ready_path" \
    ANDROID_SDK_ROOT="$test_root/sdk" \
    NATIVE_SMOKE_APP_ID=com.example \
    NATIVE_SMOKE_BUILD_ID=android-build \
    NATIVE_SMOKE_EMAIL=smoke@example.test \
    NATIVE_SMOKE_PASSWORD=secret-value-must-not-print
)"
assert_contains \
  "$missing_app_output" \
  "The release-candidate application is not installed on the connected device."
assert_not_contains "$missing_app_output" "secret-value-must-not-print"
assert_not_contains "$missing_app_output" "com.example"

missing_output="$(
  missing_utilities="$test_root/missing"
  make_utilities "$missing_utilities" no
  run_case missing-prerequisites 2 "$missing_utilities"
)"
assert_contains "$missing_output" "Required command is missing: sdkmanager"
assert_contains "$missing_output" "Required Android SDK tool is missing: aapt2."
assert_contains "$missing_output" "Required release value is missing: NATIVE_SMOKE_APP_ID"
assert_not_contains "$missing_output" "secret-value-must-not-print"

cleanup_test_fixtures
trap - EXIT

echo "Android preflight regression tests passed."