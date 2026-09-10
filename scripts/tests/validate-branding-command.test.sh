#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

pnpm --filter @workspace/chat-app run validate:branding

cat > "$TEST_ROOT/ios-native-info.json" <<'JSON'
{
  "CFBundleDisplayName": "RealtimeAlgoChatApp Studio",
  "CFBundleName": "RealtimeAlgoChatApp Studio",
  "NSCameraUsageDescription": "RealtimeAlgoChatApp Studio uses your camera for video calls.",
  "NSMicrophoneUsageDescription": "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls."
}
JSON

pnpm --filter @workspace/chat-app run validate:branding:native -- \
  --platform ios \
  --metadata "$TEST_ROOT/ios-native-info.json" \
  --build-id ios-command-test \
  --results-dir "$TEST_ROOT/ios-results"

assert_contains "$TEST_ROOT/ios-results/native-branding-check.md" "- Status: **PASS**"
assert_contains "$TEST_ROOT/ios-results/native-branding-summary.md" "Candidate build ID: \`ios-command-test\`"

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
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Candidate build ID: \`android-command-test\`"
assert_contains "$TEST_ROOT/android-results/native-branding-summary.md" "Mismatch:"

echo "Native branding command regression tests passed."