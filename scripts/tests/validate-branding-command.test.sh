#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Native branding command test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    cat "$file" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

pnpm --filter @workspace/chat-app run validate:branding

cat > "$TEST_ROOT/ios-native-info.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON

pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform ios \
  --metadata "$TEST_ROOT/ios-native-info.json" \
  --build-id ios-command-test \
  --results-dir "$TEST_ROOT/ios-results"

assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "Candidate build ID: \`ios-command-test\`"
# Candidate build IDs are non-secret release configuration and remain visible
# beside the fingerprint in the GitHub summary.
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build ID: \`ios-command-test\`"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"

cat > "$TEST_ROOT/android-native-info.json" <<'JSON'
{
  "applicationLabel": "Old App",
  "permissions": ["android.permission.CAMERA"]
}
JSON

if pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform android \
  --metadata "$TEST_ROOT/android-native-info.json" \
  --build-id android-command-test \
  --results-dir "$TEST_ROOT/android-results"; then
  echo "Expected the mismatched Android branding command to fail." >&2
  exit 1
fi

assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Mismatch:"

# Incomplete metadata from an early inspection failure must still produce an
# actionable summary: the candidate build ID, the mismatched or unavailable
# field, and the detailed report link survive every failure path below.
expect_incomplete_metadata_failure() {
  local name="$1"
  local platform="$2"
  local expected_detail="$3"
  local expected_permission_line="$4"
  local results_dir="$TEST_ROOT/$name-results"
  local log="$TEST_ROOT/$name.log"

  if pnpm --filter @workspace/chat-app run validate:branding:native -- \
    --platform "$platform" \
    --metadata "$TEST_ROOT/$name.json" \
    --build-id "$name-build" \
    --results-dir "$results_dir" >"$log" 2>&1; then
    echo "Expected the $name native branding command to fail." >&2
    cat "$log" >&2
    exit 1
  fi

  assert_contains "$results_dir/native-branding-check.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-check.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-check.md" "$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-summary.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-summary.md" "$expected_permission_line"
  assert_contains "$results_dir/native-branding-summary.md" "Mismatch: \`$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "Detailed report: [native-branding-check.md](__NATIVE_BRANDING_REPORT_URL__)"
}

cat > "$TEST_ROOT/ios-missing-label.json" <<'JSON'
{
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-label ios \
  "Native iOS metadata is missing CFBundleDisplayName" \
  "- Permission copy: **PASS** (camera and microphone)"
assert_contains "$TEST_ROOT/ios-missing-label-results/native-branding-summary.md" "- Native label: \`Unavailable\`"

cat > "$TEST_ROOT/ios-missing-permission.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-permission ios \
  "Native iOS metadata is missing NSCameraUsageDescription" \
  "- Permission copy: **FAIL** (unavailable field: NSCameraUsageDescription)"

# Parser messages quote the offending input, and Node prints the source line of
# an uncaught JSON SyntaxError, so a malformed metadata file must be reported
# with a fixed reason: the private identifier below may not reach the report,
# the summary, or the command output.
printf '{ "CFBundleIdentifier": "com.example.private-app-id", ' > "$TEST_ROOT/ios-malformed.json"
expect_incomplete_metadata_failure ios-malformed ios \
  "Native iOS metadata is not valid JSON" \
  "- Permission copy: **UNAVAILABLE** (native metadata could not be inspected)"
assert_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "- Native label: \`Unavailable\`"
assert_not_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "mismatched field"
for output in \
  "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" \
  "$TEST_ROOT/ios-malformed-results/native-branding-check.md" \
  "$TEST_ROOT/ios-malformed.log"; do
  assert_not_contains "$output" "private-app-id"
done

cat > "$TEST_ROOT/android-missing-declarations.json" <<'JSON'
{
  "applicationLabel": "RealtimeAlgoChatApp"
}
JSON
expect_incomplete_metadata_failure android-missing-declarations android \
  "Native Android metadata is missing permissions" \
  "- Permission declarations: **FAIL** (unavailable field: permissions)"
assert_not_contains "$TEST_ROOT/android-missing-declarations-results/native-branding-summary.md" "missing: android.permission"

cleanup_test_fixtures
trap - EXIT

echo "Native branding command regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Native branding command test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    cat "$file" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

pnpm --filter @workspace/chat-app run validate:branding

cat > "$TEST_ROOT/ios-native-info.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON

pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform ios \
  --metadata "$TEST_ROOT/ios-native-info.json" \
  --build-id ios-command-test \
  --results-dir "$TEST_ROOT/ios-results"

assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "Candidate build ID: \`ios-command-test\`"
# Candidate build IDs are non-secret release configuration and remain visible
# beside the fingerprint in the GitHub summary.
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build ID: \`ios-command-test\`"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"

cat > "$TEST_ROOT/android-native-info.json" <<'JSON'
{
  "applicationLabel": "Old App",
  "permissions": ["android.permission.CAMERA"]
}
JSON

if pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform android \
  --metadata "$TEST_ROOT/android-native-info.json" \
  --build-id android-command-test \
  --results-dir "$TEST_ROOT/android-results"; then
  echo "Expected the mismatched Android branding command to fail." >&2
  exit 1
fi

assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Mismatch:"

# Incomplete metadata from an early inspection failure must still produce an
# actionable summary: the candidate build ID, the mismatched or unavailable
# field, and the detailed report link survive every failure path below.
expect_incomplete_metadata_failure() {
  local name="$1"
  local platform="$2"
  local expected_detail="$3"
  local expected_permission_line="$4"
  local results_dir="$TEST_ROOT/$name-results"
  local log="$TEST_ROOT/$name.log"

  if pnpm --filter @workspace/chat-app run validate:branding:native -- \
    --platform "$platform" \
    --metadata "$TEST_ROOT/$name.json" \
    --build-id "$name-build" \
    --results-dir "$results_dir" >"$log" 2>&1; then
    echo "Expected the $name native branding command to fail." >&2
    cat "$log" >&2
    exit 1
  fi

  assert_contains "$results_dir/native-branding-check.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-check.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-check.md" "$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-summary.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-summary.md" "$expected_permission_line"
  assert_contains "$results_dir/native-branding-summary.md" "Mismatch: \`$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "Detailed report: [native-branding-check.md](__NATIVE_BRANDING_REPORT_URL__)"
}

cat > "$TEST_ROOT/ios-missing-label.json" <<'JSON'
{
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-label ios \
  "Native iOS metadata is missing CFBundleDisplayName" \
  "- Permission copy: **PASS** (camera and microphone)"
assert_contains "$TEST_ROOT/ios-missing-label-results/native-branding-summary.md" "- Native label: \`Unavailable\`"

cat > "$TEST_ROOT/ios-missing-permission.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-permission ios \
  "Native iOS metadata is missing NSCameraUsageDescription" \
  "- Permission copy: **FAIL** (unavailable field: NSCameraUsageDescription)"

# Parser messages quote the offending input, and Node prints the source line of
# an uncaught JSON SyntaxError, so a malformed metadata file must be reported
# with a fixed reason: the private identifier below may not reach the report,
# the summary, or the command output.
printf '{ "CFBundleIdentifier": "com.example.private-app-id", ' > "$TEST_ROOT/ios-malformed.json"
expect_incomplete_metadata_failure ios-malformed ios \
  "Native iOS metadata is not valid JSON" \
  "- Permission copy: **UNAVAILABLE** (native metadata could not be inspected)"
assert_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "- Native label: \`Unavailable\`"
assert_not_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "mismatched field"
for output in \
  "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" \
  "$TEST_ROOT/ios-malformed-results/native-branding-check.md" \
  "$TEST_ROOT/ios-malformed.log"; do
  assert_not_contains "$output" "private-app-id"
done

cat > "$TEST_ROOT/android-missing-declarations.json" <<'JSON'
{
  "applicationLabel": "RealtimeAlgoChatApp"
}
JSON
expect_incomplete_metadata_failure android-missing-declarations android \
  "Native Android metadata is missing permissions" \
  "- Permission declarations: **FAIL** (unavailable field: permissions)"
assert_not_contains "$TEST_ROOT/android-missing-declarations-results/native-branding-summary.md" "missing: android.permission"

cleanup_test_fixtures
trap - EXIT

echo "Native branding command regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Native branding command test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    cat "$file" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

pnpm --filter @workspace/chat-app run validate:branding

cat > "$TEST_ROOT/ios-native-info.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON

pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform ios \
  --metadata "$TEST_ROOT/ios-native-info.json" \
  --build-id ios-command-test \
  --results-dir "$TEST_ROOT/ios-results"

assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "Candidate build ID: \`ios-command-test\`"
# Candidate build IDs are non-secret release configuration and remain visible
# beside the fingerprint in the GitHub summary.
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build ID: \`ios-command-test\`"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"

cat > "$TEST_ROOT/android-native-info.json" <<'JSON'
{
  "applicationLabel": "Old App",
  "permissions": ["android.permission.CAMERA"]
}
JSON

if pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform android \
  --metadata "$TEST_ROOT/android-native-info.json" \
  --build-id android-command-test \
  --results-dir "$TEST_ROOT/android-results"; then
  echo "Expected the mismatched Android branding command to fail." >&2
  exit 1
fi

assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Mismatch:"

# Incomplete metadata from an early inspection failure must still produce an
# actionable summary: the candidate build ID, the mismatched or unavailable
# field, and the detailed report link survive every failure path below.
expect_incomplete_metadata_failure() {
  local name="$1"
  local platform="$2"
  local expected_detail="$3"
  local expected_permission_line="$4"
  local results_dir="$TEST_ROOT/$name-results"
  local log="$TEST_ROOT/$name.log"

  if pnpm --filter @workspace/chat-app run validate:branding:native -- \
    --platform "$platform" \
    --metadata "$TEST_ROOT/$name.json" \
    --build-id "$name-build" \
    --results-dir "$results_dir" >"$log" 2>&1; then
    echo "Expected the $name native branding command to fail." >&2
    cat "$log" >&2
    exit 1
  fi

  assert_contains "$results_dir/native-branding-check.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-check.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-check.md" "$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-summary.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-summary.md" "$expected_permission_line"
  assert_contains "$results_dir/native-branding-summary.md" "Mismatch: \`$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "Detailed report: [native-branding-check.md](__NATIVE_BRANDING_REPORT_URL__)"
}

cat > "$TEST_ROOT/ios-missing-label.json" <<'JSON'
{
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-label ios \
  "Native iOS metadata is missing CFBundleDisplayName" \
  "- Permission copy: **PASS** (camera and microphone)"
assert_contains "$TEST_ROOT/ios-missing-label-results/native-branding-summary.md" "- Native label: \`Unavailable\`"

cat > "$TEST_ROOT/ios-missing-permission.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-permission ios \
  "Native iOS metadata is missing NSCameraUsageDescription" \
  "- Permission copy: **FAIL** (unavailable field: NSCameraUsageDescription)"

# Parser messages quote the offending input, and Node prints the source line of
# an uncaught JSON SyntaxError, so a malformed metadata file must be reported
# with a fixed reason: the private identifier below may not reach the report,
# the summary, or the command output.
printf '{ "CFBundleIdentifier": "com.example.private-app-id", ' > "$TEST_ROOT/ios-malformed.json"
expect_incomplete_metadata_failure ios-malformed ios \
  "Native iOS metadata is not valid JSON" \
  "- Permission copy: **UNAVAILABLE** (native metadata could not be inspected)"
assert_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "- Native label: \`Unavailable\`"
assert_not_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "mismatched field"
for output in \
  "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" \
  "$TEST_ROOT/ios-malformed-results/native-branding-check.md" \
  "$TEST_ROOT/ios-malformed.log"; do
  assert_not_contains "$output" "private-app-id"
done

cat > "$TEST_ROOT/android-missing-declarations.json" <<'JSON'
{
  "applicationLabel": "RealtimeAlgoChatApp"
}
JSON
expect_incomplete_metadata_failure android-missing-declarations android \
  "Native Android metadata is missing permissions" \
  "- Permission declarations: **FAIL** (unavailable field: permissions)"
assert_not_contains "$TEST_ROOT/android-missing-declarations-results/native-branding-summary.md" "missing: android.permission"

cleanup_test_fixtures
trap - EXIT

echo "Native branding command regression tests passed."#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Native branding command test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    cat "$file" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

pnpm --filter @workspace/chat-app run validate:branding

cat > "$TEST_ROOT/ios-native-info.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON

pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform ios \
  --metadata "$TEST_ROOT/ios-native-info.json" \
  --build-id ios-command-test \
  --results-dir "$TEST_ROOT/ios-results"

assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "Candidate build ID: \`ios-command-test\`"
# Candidate build IDs are non-secret release configuration and remain visible
# beside the fingerprint in the GitHub summary.
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build ID: \`ios-command-test\`"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"

cat > "$TEST_ROOT/android-native-info.json" <<'JSON'
{
  "applicationLabel": "Old App",
  "permissions": ["android.permission.CAMERA"]
}
JSON

if pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform android \
  --metadata "$TEST_ROOT/android-native-info.json" \
  --build-id android-command-test \
  --results-dir "$TEST_ROOT/android-results"; then
  echo "Expected the mismatched Android branding command to fail." >&2
  exit 1
fi

assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-check.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "- Status: **FAIL**"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build fingerprint (SHA-256):"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Mismatch:"

# Incomplete metadata from an early inspection failure must still produce an
# actionable summary: the candidate build ID, the mismatched or unavailable
# field, and the detailed report link survive every failure path below.
expect_incomplete_metadata_failure() {
  local name="$1"
  local platform="$2"
  local expected_detail="$3"
  local expected_permission_line="$4"
  local results_dir="$TEST_ROOT/$name-results"
  local log="$TEST_ROOT/$name.log"

  if pnpm --filter @workspace/chat-app run validate:branding:native -- \
    --platform "$platform" \
    --metadata "$TEST_ROOT/$name.json" \
    --build-id "$name-build" \
    --results-dir "$results_dir" >"$log" 2>&1; then
    echo "Expected the $name native branding command to fail." >&2
    cat "$log" >&2
    exit 1
  fi

  assert_contains "$results_dir/native-branding-check.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-check.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-check.md" "$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "- Status: **FAIL**"
  assert_contains "$results_dir/native-branding-summary.md" "Candidate build ID: \`$name-build\`"
  assert_contains "$results_dir/native-branding-summary.md" "$expected_permission_line"
  assert_contains "$results_dir/native-branding-summary.md" "Mismatch: \`$expected_detail"
  assert_contains "$results_dir/native-branding-summary.md" "Detailed report: [native-branding-check.md](__NATIVE_BRANDING_REPORT_URL__)"
}

cat > "$TEST_ROOT/ios-missing-label.json" <<'JSON'
{
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-label ios \
  "Native iOS metadata is missing CFBundleDisplayName" \
  "- Permission copy: **PASS** (camera and microphone)"
assert_contains "$TEST_ROOT/ios-missing-label-results/native-branding-summary.md" "- Native label: \`Unavailable\`"

cat > "$TEST_ROOT/ios-missing-permission.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp",
  "CFBundleName": "RealtimeAlgoChatApp",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp uses your microphone for voice and video calls."
}
JSON
expect_incomplete_metadata_failure ios-missing-permission ios \
  "Native iOS metadata is missing NSCameraUsageDescription" \
  "- Permission copy: **FAIL** (unavailable field: NSCameraUsageDescription)"

# Parser messages quote the offending input, and Node prints the source line of
# an uncaught JSON SyntaxError, so a malformed metadata file must be reported
# with a fixed reason: the private identifier below may not reach the report,
# the summary, or the command output.
printf '{ "CFBundleIdentifier": "com.example.private-app-id", ' > "$TEST_ROOT/ios-malformed.json"
expect_incomplete_metadata_failure ios-malformed ios \
  "Native iOS metadata is not valid JSON" \
  "- Permission copy: **UNAVAILABLE** (native metadata could not be inspected)"
assert_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "- Native label: \`Unavailable\`"
assert_not_contains "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" "mismatched field"
for output in \
  "$TEST_ROOT/ios-malformed-results/native-branding-summary.md" \
  "$TEST_ROOT/ios-malformed-results/native-branding-check.md" \
  "$TEST_ROOT/ios-malformed.log"; do
  assert_not_contains "$output" "private-app-id"
done

cat > "$TEST_ROOT/android-missing-declarations.json" <<'JSON'
{
  "applicationLabel": "RealtimeAlgoChatApp"
}
JSON
expect_incomplete_metadata_failure android-missing-declarations android \
  "Native Android metadata is missing permissions" \
  "- Permission declarations: **FAIL** (unavailable field: permissions)"
assert_not_contains "$TEST_ROOT/android-missing-declarations-results/native-branding-summary.md" "missing: android.permission"

cleanup_test_fixtures
trap - EXIT

echo "Native branding command regression tests passed."