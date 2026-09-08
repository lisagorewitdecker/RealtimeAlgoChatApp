#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
GATE="$WORKSPACE_ROOT/artifacts/chat-app/e2e/native-large-text/run.sh"
BASH_BIN="$(command -v bash)"
ENV_BIN="$(command -v env)"
LN_BIN="$(command -v ln)"
MKTEMP_BIN="$(command -v mktemp)"
MKDIR_BIN="$(command -v mkdir)"
RM_BIN="$(command -v rm)"
GREP_BIN="$(command -v grep)"

test_root="$("$MKTEMP_BIN" -d)"
trap '"$RM_BIN" -rf "$test_root"' EXIT

utilities="$test_root/utilities"
"$MKDIR_BIN" -p "$utilities" "$test_root/home"
for command in cat date dirname find head mkdir sed tr wc; do
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

make_xcrun_stub() {
  local path="$1"
  local booted_devices="$2"
  {
    printf '#!%s\n' "$BASH_BIN"
    printf 'printf "%%s\\n" %q\n' "$booted_devices"
  } >"$path/xcrun"
  chmod +x "$path/xcrun"
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
    printf 'Expected output not to contain credential sentinel: %s\n%s\n' \
      "$unexpected" "$output" >&2
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
    PATH="$path:$utilities" \
    HOME="$test_root/home" \
    NATIVE_SMOKE_APP_ID=app-id-secret-sentinel \
    NATIVE_SMOKE_BUILD_ID=build-id-secret-sentinel \
    NATIVE_SMOKE_EMAIL=email-secret-sentinel \
    NATIVE_SMOKE_PASSWORD=password-secret-sentinel \
    NATIVE_SMOKE_RESULTS_DIR="$test_root/$name-results" \
    "$@" \
    "$BASH_BIN" "$GATE" ios 2>&1
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

  for sentinel in \
    app-id-secret-sentinel \
    build-id-secret-sentinel \
    email-secret-sentinel \
    password-secret-sentinel; do
    assert_not_contains "$output" "$sentinel"
  done
}

missing_maestro_path="$(make_command_path missing-maestro)"
rm "$missing_maestro_path/maestro"
missing_maestro_output="$(
  run_case missing-maestro 2 "$missing_maestro_path"
)"
assert_contains "$missing_maestro_output" "Required command not found: maestro"

missing_xcrun_path="$(make_command_path missing-xcrun)"
missing_xcrun_output="$(
  run_case missing-xcrun 2 "$missing_xcrun_path"
)"
assert_contains "$missing_xcrun_output" "xcrun is required for the iOS smoke test."

unavailable_simulator_path="$(make_command_path unavailable-simulator)"
make_xcrun_stub "$unavailable_simulator_path" ""
unavailable_simulator_output="$(
  run_case unavailable-simulator 2 "$unavailable_simulator_path"
)"
assert_contains \
  "$unavailable_simulator_output" \
  "Boot the smallest supported iOS simulator (iPhone SE, 3rd generation) first."

supported_model_path="$(make_command_path supported-model)"
make_xcrun_stub \
  "$supported_model_path" \
  "iPhone SE (3rd generation) (00000000-0000-0000-0000-000000000000) (Booted)"
supported_model_output="$(
  run_case supported-model 1 "$supported_model_path"
)"
assert_contains \
  "$supported_model_output" \
  "Expected at least 11 native screenshots, found 0."

wrong_model_path="$(make_command_path wrong-model)"
make_xcrun_stub \
  "$wrong_model_path" \
  "iPhone 14 (00000000-0000-0000-0000-000000000000) (Booted)"
wrong_model_output="$(
  run_case wrong-model 2 "$wrong_model_path"
)"
assert_contains \
  "$wrong_model_output" \
  "Expected a booted iPhone SE simulator, found: iPhone 14"

echo "iOS native large-text readiness regression tests passed."