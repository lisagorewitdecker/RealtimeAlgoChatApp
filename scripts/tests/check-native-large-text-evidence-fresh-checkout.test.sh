#!/usr/bin/env bash
set -euo pipefail

# The root unit suite must pass on a fresh clone or a new git worktree, where
# artifacts/api-server/test-results/ does not exist: it is Playwright's
# gitignored output directory and only appears after the API browser suite has
# run locally. This regression runs the native large-text evidence suite from
# an isolated copy of the repository layout that carries no test output at all
# and proves that it passes, names the missing Playwright status explicitly
# instead of failing on it, and leaves no test output behind.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITE_RELATIVE_PATH="scripts/tests/check-native-large-text-evidence.test.sh"
PLAYWRIGHT_OUTPUT_RELATIVE_DIR="artifacts/api-server/test-results"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Fresh-checkout native evidence test cleanup escaped its fixture directory" >&2
    return 1
  fi
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

# Playwright clears its output directory at the start of every run, so nothing
# under it can be durable evidence and nothing there may be tracked; otherwise
# a fresh checkout would carry test output that the next local run deletes.
if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_playwright_output="$(git -C "$ROOT_DIR" ls-files -- "$PLAYWRIGHT_OUTPUT_RELATIVE_DIR")"
  if [[ -n "$tracked_playwright_output" ]]; then
    printf 'Playwright output under %s must stay untracked; tracked files:\n%s\n' \
      "$PLAYWRIGHT_OUTPUT_RELATIVE_DIR" "$tracked_playwright_output" >&2
    exit 1
  fi
else
  printf 'Skipping the tracked Playwright output check: %s is not inside a git work tree.\n' \
    "$ROOT_DIR"
fi

# Build the fresh-checkout layout: only the suite, the checker it exercises,
# the checker's own helpers, and the root package.json the suite reads for the
# release Node range. There is deliberately no artifacts/ tree, so the layout
# matches a clone that has never run the API browser suite.
fresh_checkout="$TEST_ROOT/fresh-checkout"
mkdir -p "$fresh_checkout/scripts/tests"
cp "$ROOT_DIR/package.json" "$fresh_checkout/package.json"
cp "$ROOT_DIR/scripts/check-native-large-text-evidence.sh" \
  "$ROOT_DIR/scripts/native-release-recovery-contract.sh" \
  "$ROOT_DIR/scripts/find-duplicate-json-object-keys.mjs" \
  "$ROOT_DIR/scripts/read-bounded-text.mjs" \
  "$fresh_checkout/scripts/"
cp "$ROOT_DIR/$SUITE_RELATIVE_PATH" "$fresh_checkout/$SUITE_RELATIVE_PATH"
missing_saved_status="$fresh_checkout/$PLAYWRIGHT_OUTPUT_RELATIVE_DIR/.last-run.json"

# Hosted tamper fixtures are a release-workflow concern; the fresh-checkout
# regression always exercises the default local fixture path.
set +e
suite_output="$(
  cd "$fresh_checkout" &&
    env -u NATIVE_EVIDENCE_TAMPER_FIXTURES_ROOT bash "$SUITE_RELATIVE_PATH" 2>&1
)"
suite_status=$?
set -e
if ((suite_status != 0)); then
  printf 'Native large-text evidence suite failed in a fresh-checkout layout without %s (exit %s):\n%s\n' \
    "$PLAYWRIGHT_OUTPUT_RELATIVE_DIR" "$suite_status" "$suite_output" >&2
  exit 1
fi
assert_contains "$suite_output" \
  "Skipping the saved API test status guard: $missing_saved_status is absent"
assert_contains "$suite_output" \
  "Native large-text evidence completeness regression tests passed."

if [[ -e "$fresh_checkout/artifacts" ]]; then
  printf 'Native large-text evidence suite created test output inside a fresh-checkout layout:\n' >&2
  find "$fresh_checkout/artifacts" >&2
  exit 1
fi

cleanup_test_fixtures
trap - EXIT

echo "Fresh-checkout native large-text evidence regression tests passed."
