#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITE_RELATIVE_PATH="scripts/tests/check-native-large-text-evidence.test.sh"
PLAYWRIGHT_OUTPUT_RELATIVE_DIR="artifacts/api-server/test-results"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
mkdir -p "$TEST_ROOT"

cleanup_test_fixtures() {
  find "$TEST_PARENT" -name '*.stop' -exec sh -c ': > "$1"' _ {} \; 2>/dev/null || true
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" <<<"$output"; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_file_contains() {
  local path="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$path"; then
    printf 'Expected output file to contain: %s\n' "$expected" >&2
    cat "$path" >&2
    exit 1
  fi
}

assert_file_not_contains() {
  local path="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$path"; then
    printf 'Expected output file not to contain: %s\n' "$unexpected" >&2
    cat "$path" >&2
    exit 1
  fi
}

run_case() {
  local case_name="$1"
  local mode="$2"
  local expected_fragment="$3"
  local expect_skip_message="$4"
  local fixture_root="$TEST_ROOT/$case_name"
  local stop_file="$TEST_PARENT/$case_name.stop"
  local output_path="$fixture_root/suite-output.txt"
  local saved_status
  local suite_output
  local suite_status
  local writer_pid
  local writer_status=0

  mkdir -p "$fixture_root/scripts/tests" "$fixture_root/$PLAYWRIGHT_OUTPUT_RELATIVE_DIR"
  cp "$ROOT_DIR/package.json" "$fixture_root/package.json"
  cp "$ROOT_DIR/scripts/check-native-large-text-evidence.sh" \
    "$ROOT_DIR/scripts/native-release-recovery-contract.sh" \
    "$ROOT_DIR/scripts/find-duplicate-json-object-keys.mjs" \
    "$ROOT_DIR/scripts/read-bounded-text.mjs" \
    "$fixture_root/scripts/"
  cp "$ROOT_DIR/$SUITE_RELATIVE_PATH" "$fixture_root/$SUITE_RELATIVE_PATH"

  saved_status="$fixture_root/$PLAYWRIGHT_OUTPUT_RELATIVE_DIR/.last-run.json"
  printf '{"status":"before"}\n' > "$saved_status"

  (
    iteration=0
    if [[ "$mode" == "delete" ]]; then
      sleep 0.05
      while [[ ! -f "$stop_file" ]]; do
        rm -f "$saved_status"
        sleep 0.01
      done
      exit 0
    fi

    if [[ "$mode" == "stable" ]]; then
       while [[ ! -f "$stop_file" ]]; do
         sleep 0.01
       done
       exit 0
    fi

    while [[ ! -f "$stop_file" ]]; do
       printf '{"status":"during","tick":%s}\n' "$iteration" > "$saved_status"
      iteration=$((iteration + 1))
      sleep 0.01
    done
  ) &
  writer_pid=$!

  set +e
  (
    cd "$fixture_root" &&
      env -u NATIVE_EVIDENCE_TAMPER_FIXTURES_ROOT bash "$SUITE_RELATIVE_PATH"
  ) >"$output_path" 2>&1
  suite_status=$?
  set -e
  suite_output="$(cat "$output_path")"

  : > "$stop_file"
  kill "$writer_pid" 2>/dev/null || true
  set +e
  wait "$writer_pid"
  writer_status=$?
  set -e
  if ((writer_status == 143 || writer_status == 130)); then
    writer_status=0
  fi
  if ((writer_status != 0)); then
    printf 'Concurrent saved-status writer failed during the %s case.\n%s\n' \
      "$case_name" "$suite_output" >&2
    exit 1
  fi

  if ((suite_status != 0)); then
    printf 'Native large-text evidence suite failed during the %s case (exit %s):\n%s\n' \
      "$case_name" "$suite_status" "$suite_output" >&2
    exit 1
  fi

  if [[ "$expect_skip_message" == "yes" ]]; then
    assert_file_contains "$output_path" \
      "Skipping the saved API test status cleanup guard: $saved_status $expected_fragment"
  else
    assert_file_not_contains "$output_path" \
      "Skipping the saved API test status cleanup guard:"
  fi
  assert_file_contains "$output_path" \
    "Native large-text evidence completeness regression tests passed."
}

run_case "concurrent-status-stable" "stable" "" "no"
run_case "concurrent-status-rewrite" "rewrite" "changed during the test" "yes"
run_case "concurrent-status-delete" "delete" "disappeared during the test" "yes"

echo "Concurrent saved-status native evidence regression tests passed."
