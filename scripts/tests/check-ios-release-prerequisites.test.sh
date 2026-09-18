#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PREFLIGHT="$WORKSPACE_ROOT/scripts/check-ios-release-prerequisites.sh"
BASH_BIN="$(command -v bash)"
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"
LN_BIN="$(command -v ln)"
MKDIR_BIN="$(command -v mkdir)"
MKTEMP_BIN="$(command -v mktemp)"
RM_BIN="$(command -v rm)"

test_parent="$("$MKTEMP_BIN" -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
"$MKDIR_BIN" -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  "$RM_BIN" -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "iOS preflight test cleanup escaped its fixture directory" >&2
    return 1
  fi
  "$RM_BIN" -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
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
    printf 'Expected output not to contain secret sentinel: %s\n%s\n' \
      "$unexpected" "$output" >&2
    exit 1
  fi
}

make_utilities() {
  local directory="$1"
  "$MKDIR_BIN" -p "$directory"
  for command in head sed tail tr grep; do
    "$LN_BIN" -s "$(command -v "$command")" "$directory/$command"
  done
}

make_runner_commands() {
  local directory="$1"
  local java_version="$2"
  local pnpm_version="$3"
  "$MKDIR_BIN" -p "$directory"

  cat >"$directory/uname" <<EOF
#!${BASH_BIN}
  case "\${1:-}" in
  -m) printf 'arm64\n' ;;
  *) printf 'Darwin\n' ;;
esac
EOF
  chmod +x "$directory/uname"

  cat >"$directory/pnpm" <<EOF
#!${BASH_BIN}
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "${pnpm_version}"
else
  exit 0
fi
EOF
  chmod +x "$directory/pnpm"

  cat >"$directory/java" <<EOF
#!${BASH_BIN}
echo 'openjdk version "${java_version}"' >&2
EOF
  chmod +x "$directory/java"

  cat >"$directory/maestro" <<EOF
#!${BASH_BIN}
  if [[ "\${1:-}" == "--version" ]]; then
  printf '1.41.0\n'
else
  exit 0
fi
EOF
  chmod +x "$directory/maestro"

  cat >"$directory/xcrun" <<EOF
#!${BASH_BIN}
set -euo pipefail
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "list" ]]; then
  if [[ "\${IOS_DEVICE_MODE:-ready}" == "wrong" ]]; then
    printf '    iPhone 14 (00000000-0000-0000-0000-000000000000) (Booted)\n'
  elif [[ "\${IOS_DEVICE_MODE:-ready}" == "ready" ]]; then
    printf '    iPhone SE (3rd generation) (ABCDEF12-3456-7890-ABCD-EF1234567890) (Booted)\n'
  elif [[ "\${IOS_DEVICE_MODE:-ready}" == "padded" ]]; then
    # Real simctl output pads device rows with trailing spaces.
    printf '    iPhone SE (3rd generation) (ABCDEF12-3456-7890-ABCD-EF1234567890) (Booted)   \n'
  fi
  exit 0
fi
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "get_app_container" ]]; then
  if [[ "\${IOS_CANDIDATE_MODE:-installed}" == "missing" ]]; then
    exit 1
  fi
  printf '%s\n' "\$IOS_APP_CONTAINER"
  exit 0
fi
exit 1
EOF
  chmod +x "$directory/xcrun"
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
    printf '%s: expected exit %s, got %s\n%s\n' \
      "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name"
  printf '%s\n' "$output"
}

ready_commands="$test_root/ready-commands"
utilities="$test_root/utilities"
candidate_container="$test_root/candidate-container"
"$MKDIR_BIN" -p "$candidate_container"
printf 'plist\n' >"$candidate_container/Info.plist"
printf 'SENTRY_RELEASE_PREFLIGHT_PASSED_V1\n' >"$candidate_container/evidence.bin"
make_utilities "$utilities"
make_runner_commands "$ready_commands" "17.0.13" "10.26.1"
ready_path="$ready_commands:$utilities"

secret_values="
ios-app-id-secret-sentinel
smoke-email-secret-sentinel
smoke-password-secret-sentinel
sentry-auth-token-secret-sentinel
ios-sentry-release-secret-sentinel
ios-sentry-dist-secret-sentinel
ios-build-id-secret-sentinel
"

ready_output="$(
  run_case ready 0 "$ready_path" \
    GITHUB_STEP_SUMMARY="$test_root/ready-summary.md" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains "$ready_output" "IOS_RELEASE_PREFLIGHT=READY"
assert_contains "$(<"$test_root/ready-summary.md")" "Status: **READY**"
while IFS= read -r secret; do
  [[ -n "$secret" ]] || continue
  assert_not_contains "$ready_output" "$secret"
  assert_not_contains "$(<"$test_root/ready-summary.md")" "$secret"
done <<<"$secret_values"

missing_values_output="$(
  run_case missing-values 2 "$ready_path" \
    GITHUB_STEP_SUMMARY="$test_root/missing-values-summary.md" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container"
)"
for missing_value in \
  NATIVE_SMOKE_IOS_APP_ID \
  NATIVE_SMOKE_EMAIL \
  NATIVE_SMOKE_PASSWORD \
  SENTRY_AUTH_TOKEN \
  NATIVE_SMOKE_IOS_SENTRY_RELEASE \
  NATIVE_SMOKE_IOS_SENTRY_DIST \
  NATIVE_SMOKE_IOS_BUILD_ID; do
  assert_contains \
    "$missing_values_output" \
    "Required release value is missing: $missing_value"
done
assert_contains "$(<"$test_root/missing-values-summary.md")" "Status: **BLOCKED**"

old_java_output="$(
  old_java_commands="$test_root/old-java-commands"
  make_runner_commands "$old_java_commands" "11.0.24" "10.26.1"
  run_case old-java 2 "$old_java_commands:$utilities" \
    GITHUB_STEP_SUMMARY="$test_root/old-java-summary.md" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains "$old_java_output" "Java 17 or newer is required; found Java 11.0.24."
assert_not_contains "$old_java_output" "smoke-password-secret-sentinel"

wrong_pnpm_output="$(
  wrong_pnpm_commands="$test_root/wrong-pnpm-commands"
  make_runner_commands "$wrong_pnpm_commands" "17.0.13" "9.15.0"
  run_case wrong-pnpm 2 "$wrong_pnpm_commands:$utilities" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains "$wrong_pnpm_output" "Required pnpm 10.26.1; found 9.15.0."
assert_not_contains "$wrong_pnpm_output" "sentry-auth-token-secret-sentinel"

wrong_device_output="$(
  run_case wrong-device 2 "$ready_path" \
    IOS_DEVICE_MODE=wrong \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains \
  "$wrong_device_output" \
  "A booted iPhone SE (3rd generation) is required on the iOS runner."
assert_not_contains "$wrong_device_output" "ios-app-id-secret-sentinel"

padded_device_output="$(
  run_case padded-device 0 "$ready_path" \
    GITHUB_STEP_SUMMARY="$test_root/padded-device-summary.md" \
    IOS_DEVICE_MODE=padded \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains "$padded_device_output" "IOS_RELEASE_PREFLIGHT=READY"
assert_not_contains \
  "$padded_device_output" \
  "A booted iPhone SE (3rd generation) is required on the iOS runner."

missing_candidate_output="$(
  run_case missing-candidate 2 "$ready_path" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=missing \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains \
  "$missing_candidate_output" \
  "The release candidate is not installed on the prepared iOS simulator."
assert_not_contains "$missing_candidate_output" "ios-app-id-secret-sentinel"

no_marker_container="$test_root/no-marker-container"
"$MKDIR_BIN" -p "$no_marker_container"
printf 'plist\n' >"$no_marker_container/Info.plist"
no_marker_output="$(
  run_case missing-marker 2 "$ready_path" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=no-marker \
    IOS_APP_CONTAINER="$no_marker_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains \
  "$no_marker_output" \
  "The installed iOS candidate does not contain crash-reporting preflight evidence."
assert_not_contains "$no_marker_output" "ios-sentry-release-secret-sentinel"

missing_tool_commands="$test_root/missing-tool-commands"
make_runner_commands "$missing_tool_commands" "17.0.13" "10.26.1"
"$RM_BIN" "$missing_tool_commands/maestro"
missing_tool_output="$(
  run_case missing-tool 2 "$missing_tool_commands:$utilities" \
    IOS_DEVICE_MODE=ready \
    IOS_CANDIDATE_MODE=installed \
    IOS_APP_CONTAINER="$candidate_container" \
    NATIVE_SMOKE_IOS_APP_ID=ios-app-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=smoke-email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=smoke-password-secret-sentinel \
    SENTRY_AUTH_TOKEN=sentry-auth-token-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_RELEASE=ios-sentry-release-secret-sentinel \
    NATIVE_SMOKE_IOS_SENTRY_DIST=ios-sentry-dist-secret-sentinel \
    NATIVE_SMOKE_IOS_BUILD_ID=ios-build-id-secret-sentinel
)"
assert_contains "$missing_tool_output" "Required command is missing: maestro"
assert_not_contains "$missing_tool_output" "smoke-password-secret-sentinel"

cleanup_test_fixtures
trap - EXIT

echo "iOS preflight regression tests passed."