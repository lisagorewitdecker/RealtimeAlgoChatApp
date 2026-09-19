#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITE_RELATIVE_PATH="scripts/tests/check-native-large-text-evidence.test.sh"
PLAYWRIGHT_OUTPUT_RELATIVE_DIR="artifacts/api-server/test-results"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
STOP_FILE="$TEST_PARENT/stop"
mkdir -p "$TEST_ROOT"

cleanup_test_fixtures() {
  : > "$STOP_FILE"
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

fixture_root="$TEST_ROOT/concurrent-status"
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
  while [[ ! -f "$STOP_FILE" ]]; do
    printf '{"status":"during","tick":%s}\n' "$iteration" > "$saved_status"
    iteration=$((iteration + 1))
    python - <<'PY'
import time
time.sleep(0.01)
PY
  done
) &
writer_pid=$!

set +e
suite_output="$(
  cd "$fixture_root" &&
    env -u NATIVE_EVIDENCE_TAMPER_FIXTURES_ROOT bash "$SUITE_RELATIVE_PATH" 2>&1
)"
suite_status=$?
set -e

: > "$STOP_FILE"
if ! wait "$writer_pid"; then
  printf 'Concurrent saved-status writer failed before the suite completed.\n%s\n' \
    "$suite_output" >&2
  exit 1
fi

if ((suite_status != 0)); then
  printf 'Native large-text evidence suite failed while the optional saved API status changed concurrently (exit %s):\n%s\n' \
    "$suite_status" "$suite_output" >&2
  exit 1
fi

assert_contains "$suite_output" \
  "Skipping the saved API test status cleanup guard: $saved_status changed during the test"
assert_contains "$suite_output" \
  "Native large-text evidence completeness regression tests passed."

echo "Concurrent saved-status native evidence regression tests passed."
