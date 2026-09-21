#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/validate-package-manifests.mjs"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Package manifest validation cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}
trap cleanup_test_fixtures EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

cat >"$TEST_ROOT/valid-package.json" <<'JSON'
{
  "name": "fixture",
  "private": true
}
JSON
valid_before="$(sha256sum "$TEST_ROOT/valid-package.json")"
valid_output="$(node "$CHECKER" "$TEST_ROOT/valid-package.json")"
assert_contains "$valid_output" "Validated 1 tracked package manifest(s)."
[[ "$valid_before" == "$(sha256sum "$TEST_ROOT/valid-package.json")" ]]

printf '%s\n' \
  '{' \
  '<<<<<<< HEAD' \
  '  "name": "before-merge"' \
  '=======' \
  '  "name": "after-merge"' \
  '>>>>>>> incoming' \
  '}' >"$TEST_ROOT/merge-marker-package.json"
merge_before="$(sha256sum "$TEST_ROOT/merge-marker-package.json")"
if merge_output="$(node "$CHECKER" "$TEST_ROOT/merge-marker-package.json" 2>&1)"; then
  echo "Expected an unresolved merge marker to fail validation." >&2
  exit 1
fi
assert_contains "$merge_output" "$TEST_ROOT/merge-marker-package.json"
assert_contains "$merge_output" "unresolved merge marker <<<<<<< on line 2"
assert_not_contains "$merge_output" "before-merge"
[[ "$merge_before" == "$(sha256sum "$TEST_ROOT/merge-marker-package.json")" ]]

printf '%s\n' '{"name":"first"}{"name":"second"}' >"$TEST_ROOT/concatenated-package.json"
concatenated_before="$(sha256sum "$TEST_ROOT/concatenated-package.json")"
if concatenated_output="$(node "$CHECKER" "$TEST_ROOT/concatenated-package.json" 2>&1)"; then
  echo "Expected concatenated JSON to fail validation." >&2
  exit 1
fi
assert_contains "$concatenated_output" "$TEST_ROOT/concatenated-package.json"
assert_contains "$concatenated_output" "trailing content after the first JSON value"
[[ "$concatenated_before" == "$(sha256sum "$TEST_ROOT/concatenated-package.json")" ]]

printf '%s\n' '{"name":}' >"$TEST_ROOT/malformed-package.json"
malformed_before="$(sha256sum "$TEST_ROOT/malformed-package.json")"
if malformed_output="$(node "$CHECKER" "$TEST_ROOT/malformed-package.json" 2>&1)"; then
  echo "Expected malformed JSON to fail validation." >&2
  exit 1
fi
assert_contains "$malformed_output" "$TEST_ROOT/malformed-package.json"
assert_contains "$malformed_output" "JSON parse error: unexpected token }"
[[ "$malformed_before" == "$(sha256sum "$TEST_ROOT/malformed-package.json")" ]]

post_merge="$ROOT_DIR/scripts/post-merge.sh"
manifest_line="$(grep -nF 'node scripts/validate-package-manifests.mjs' "$post_merge" | cut -d: -f1)"
install_line="$(grep -nF 'pnpm install --frozen-lockfile' "$post_merge" | cut -d: -f1)"
if [[ -z "$manifest_line" || -z "$install_line" || "$manifest_line" -ge "$install_line" ]]; then
  echo "Post-merge setup must validate manifests before pnpm install." >&2
  exit 1
fi

cleanup_test_fixtures
trap - EXIT
echo "Package manifest validation regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/validate-package-manifests.mjs"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Package manifest validation cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}
trap cleanup_test_fixtures EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

cat >"$TEST_ROOT/valid-package.json" <<'JSON'
{
  "name": "fixture",
  "private": true
}
JSON
valid_before="$(sha256sum "$TEST_ROOT/valid-package.json")"
valid_output="$(node "$CHECKER" "$TEST_ROOT/valid-package.json")"
assert_contains "$valid_output" "Validated 1 tracked package manifest(s)."
[[ "$valid_before" == "$(sha256sum "$TEST_ROOT/valid-package.json")" ]]

printf '%s\n' \
  '{' \
  '<<<<<<< HEAD' \
  '  "name": "before-merge"' \
  '=======' \
  '  "name": "after-merge"' \
  '>>>>>>> incoming' \
  '}' >"$TEST_ROOT/merge-marker-package.json"
merge_before="$(sha256sum "$TEST_ROOT/merge-marker-package.json")"
if merge_output="$(node "$CHECKER" "$TEST_ROOT/merge-marker-package.json" 2>&1)"; then
  echo "Expected an unresolved merge marker to fail validation." >&2
  exit 1
fi
assert_contains "$merge_output" "$TEST_ROOT/merge-marker-package.json"
assert_contains "$merge_output" "unresolved merge marker <<<<<<< on line 2"
assert_not_contains "$merge_output" "before-merge"
[[ "$merge_before" == "$(sha256sum "$TEST_ROOT/merge-marker-package.json")" ]]

printf '%s\n' '{"name":"first"}{"name":"second"}' >"$TEST_ROOT/concatenated-package.json"
concatenated_before="$(sha256sum "$TEST_ROOT/concatenated-package.json")"
if concatenated_output="$(node "$CHECKER" "$TEST_ROOT/concatenated-package.json" 2>&1)"; then
  echo "Expected concatenated JSON to fail validation." >&2
  exit 1
fi
assert_contains "$concatenated_output" "$TEST_ROOT/concatenated-package.json"
assert_contains "$concatenated_output" "trailing content after the first JSON value"
[[ "$concatenated_before" == "$(sha256sum "$TEST_ROOT/concatenated-package.json")" ]]

printf '%s\n' '{"name":}' >"$TEST_ROOT/malformed-package.json"
malformed_before="$(sha256sum "$TEST_ROOT/malformed-package.json")"
if malformed_output="$(node "$CHECKER" "$TEST_ROOT/malformed-package.json" 2>&1)"; then
  echo "Expected malformed JSON to fail validation." >&2
  exit 1
fi
assert_contains "$malformed_output" "$TEST_ROOT/malformed-package.json"
assert_contains "$malformed_output" "JSON parse error: unexpected token }"
[[ "$malformed_before" == "$(sha256sum "$TEST_ROOT/malformed-package.json")" ]]

post_merge="$ROOT_DIR/scripts/post-merge.sh"
manifest_line="$(grep -nF 'node scripts/validate-package-manifests.mjs' "$post_merge" | cut -d: -f1)"
install_line="$(grep -nF 'pnpm install --frozen-lockfile' "$post_merge" | cut -d: -f1)"
if [[ -z "$manifest_line" || -z "$install_line" || "$manifest_line" -ge "$install_line" ]]; then
  echo "Post-merge setup must validate manifests before pnpm install." >&2
  exit 1
fi

cleanup_test_fixtures
trap - EXIT
echo "Package manifest validation regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/validate-package-manifests.mjs"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Package manifest validation cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}
trap cleanup_test_fixtures EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

cat >"$TEST_ROOT/valid-package.json" <<'JSON'
{
  "name": "fixture",
  "private": true
}
JSON
valid_before="$(sha256sum "$TEST_ROOT/valid-package.json")"
valid_output="$(node "$CHECKER" "$TEST_ROOT/valid-package.json")"
assert_contains "$valid_output" "Validated 1 tracked package manifest(s)."
[[ "$valid_before" == "$(sha256sum "$TEST_ROOT/valid-package.json")" ]]

printf '%s\n' \
  '{' \
  '<<<<<<< HEAD' \
  '  "name": "before-merge"' \
  '=======' \
  '  "name": "after-merge"' \
  '>>>>>>> incoming' \
  '}' >"$TEST_ROOT/merge-marker-package.json"
merge_before="$(sha256sum "$TEST_ROOT/merge-marker-package.json")"
if merge_output="$(node "$CHECKER" "$TEST_ROOT/merge-marker-package.json" 2>&1)"; then
  echo "Expected an unresolved merge marker to fail validation." >&2
  exit 1
fi
assert_contains "$merge_output" "$TEST_ROOT/merge-marker-package.json"
assert_contains "$merge_output" "unresolved merge marker <<<<<<< on line 2"
assert_not_contains "$merge_output" "before-merge"
[[ "$merge_before" == "$(sha256sum "$TEST_ROOT/merge-marker-package.json")" ]]

printf '%s\n' '{"name":"first"}{"name":"second"}' >"$TEST_ROOT/concatenated-package.json"
concatenated_before="$(sha256sum "$TEST_ROOT/concatenated-package.json")"
if concatenated_output="$(node "$CHECKER" "$TEST_ROOT/concatenated-package.json" 2>&1)"; then
  echo "Expected concatenated JSON to fail validation." >&2
  exit 1
fi
assert_contains "$concatenated_output" "$TEST_ROOT/concatenated-package.json"
assert_contains "$concatenated_output" "trailing content after the first JSON value"
[[ "$concatenated_before" == "$(sha256sum "$TEST_ROOT/concatenated-package.json")" ]]

printf '%s\n' '{"name":}' >"$TEST_ROOT/malformed-package.json"
malformed_before="$(sha256sum "$TEST_ROOT/malformed-package.json")"
if malformed_output="$(node "$CHECKER" "$TEST_ROOT/malformed-package.json" 2>&1)"; then
  echo "Expected malformed JSON to fail validation." >&2
  exit 1
fi
assert_contains "$malformed_output" "$TEST_ROOT/malformed-package.json"
assert_contains "$malformed_output" "JSON parse error: unexpected token }"
[[ "$malformed_before" == "$(sha256sum "$TEST_ROOT/malformed-package.json")" ]]

post_merge="$ROOT_DIR/scripts/post-merge.sh"
manifest_line="$(grep -nF 'node scripts/validate-package-manifests.mjs' "$post_merge" | cut -d: -f1)"
install_line="$(grep -nF 'pnpm install --frozen-lockfile' "$post_merge" | cut -d: -f1)"
if [[ -z "$manifest_line" || -z "$install_line" || "$manifest_line" -ge "$install_line" ]]; then
  echo "Post-merge setup must validate manifests before pnpm install." >&2
  exit 1
fi

cleanup_test_fixtures
trap - EXIT
echo "Package manifest validation regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/validate-package-manifests.mjs"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Package manifest validation cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}
trap cleanup_test_fixtures EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

cat >"$TEST_ROOT/valid-package.json" <<'JSON'
{
  "name": "fixture",
  "private": true
}
JSON
valid_before="$(sha256sum "$TEST_ROOT/valid-package.json")"
valid_output="$(node "$CHECKER" "$TEST_ROOT/valid-package.json")"
assert_contains "$valid_output" "Validated 1 tracked package manifest(s)."
[[ "$valid_before" == "$(sha256sum "$TEST_ROOT/valid-package.json")" ]]

printf '%s\n' \
  '{' \
  '<<<<<<< HEAD' \
  '  "name": "before-merge"' \
  '=======' \
  '  "name": "after-merge"' \
  '>>>>>>> incoming' \
  '}' >"$TEST_ROOT/merge-marker-package.json"
merge_before="$(sha256sum "$TEST_ROOT/merge-marker-package.json")"
if merge_output="$(node "$CHECKER" "$TEST_ROOT/merge-marker-package.json" 2>&1)"; then
  echo "Expected an unresolved merge marker to fail validation." >&2
  exit 1
fi
assert_contains "$merge_output" "$TEST_ROOT/merge-marker-package.json"
assert_contains "$merge_output" "unresolved merge marker <<<<<<< on line 2"
assert_not_contains "$merge_output" "before-merge"
[[ "$merge_before" == "$(sha256sum "$TEST_ROOT/merge-marker-package.json")" ]]

printf '%s\n' '{"name":"first"}{"name":"second"}' >"$TEST_ROOT/concatenated-package.json"
concatenated_before="$(sha256sum "$TEST_ROOT/concatenated-package.json")"
if concatenated_output="$(node "$CHECKER" "$TEST_ROOT/concatenated-package.json" 2>&1)"; then
  echo "Expected concatenated JSON to fail validation." >&2
  exit 1
fi
assert_contains "$concatenated_output" "$TEST_ROOT/concatenated-package.json"
assert_contains "$concatenated_output" "trailing content after the first JSON value"
[[ "$concatenated_before" == "$(sha256sum "$TEST_ROOT/concatenated-package.json")" ]]

printf '%s\n' '{"name":}' >"$TEST_ROOT/malformed-package.json"
malformed_before="$(sha256sum "$TEST_ROOT/malformed-package.json")"
if malformed_output="$(node "$CHECKER" "$TEST_ROOT/malformed-package.json" 2>&1)"; then
  echo "Expected malformed JSON to fail validation." >&2
  exit 1
fi
assert_contains "$malformed_output" "$TEST_ROOT/malformed-package.json"
assert_contains "$malformed_output" "JSON parse error: unexpected token }"
[[ "$malformed_before" == "$(sha256sum "$TEST_ROOT/malformed-package.json")" ]]

post_merge="$ROOT_DIR/scripts/post-merge.sh"
manifest_line="$(grep -nF 'node scripts/validate-package-manifests.mjs' "$post_merge" | cut -d: -f1)"
install_line="$(grep -nF 'pnpm install --frozen-lockfile' "$post_merge" | cut -d: -f1)"
if [[ -z "$manifest_line" || -z "$install_line" || "$manifest_line" -ge "$install_line" ]]; then
  echo "Post-merge setup must validate manifests before pnpm install." >&2
  exit 1
fi

cleanup_test_fixtures
trap - EXIT
echo "Package manifest validation regression tests passed."