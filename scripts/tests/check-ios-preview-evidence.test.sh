#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-ios-preview-evidence.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

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

write_record() {
  local path="$1"
  cat >"$path"
}

write_preflight() {
  local path="$1"
  cat >"$path"
}

blocked_record="$TEST_ROOT/blocked/validation-record.md"
mkdir -p "$(dirname "$blocked_record")"
write_record "$blocked_record" <<'EOF'
# iOS SDK 57 preview validation record

**Result: BLOCKED — no physical iPhone handoff was available**

## Metadata

| Field | Result |
| --- | --- |
| Device model | **BLOCKED** — no physical iPhone was available |
| iOS version | **BLOCKED** — no physical iPhone was available |
| Expo Go version | **BLOCKED** — no Expo Go session was available |

## Boundary results

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | Public manifest returned HTTP 200. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local probe was not run. |
| Expo Go launch on physical iPhone | **BLOCKED** | No physical iPhone was available. |
| Server-side native request evidence | **BLOCKED** | No native iOS request was available. |
EOF
blocked_preflight="$(dirname "$blocked_record")/ios-preview-preflight.json"
write_preflight "$blocked_preflight" <<'EOF'
{
  "schema": "ios-preview-handoff-preflight/v1",
  "platform": "ios",
  "boundaries": {
    "publicManifestReachability": {
      "status": "PASS",
      "evidence": "public manifest HTTP 200 (128 bytes)"
    },
    "localHandoffProbe": {
      "status": "NOT_RUN",
      "evidence": "Local manifest/bundle probe not run — no successful probe result was recorded"
    },
    "expoGoLaunch": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires a physical iPhone running stock Expo Go."
    },
    "serverNativeRequestEvidence": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires filtered Metro or API evidence from that physical Expo Go session."
    }
  }
}
EOF
blocked_output="$(bash "$CHECKER" "$blocked_record" 2>&1)"
assert_contains "$blocked_output" "validation passed"

public_failure_record="$TEST_ROOT/public-failure/validation-record.md"
mkdir -p "$(dirname "$public_failure_record")"
write_record "$public_failure_record" <<'EOF'
# iOS SDK 57 preview validation record

**Result: FAIL — public Expo preview edge was unavailable**

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | FAIL | Public manifest probe failed. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local probe was not run because the public edge failed. |
| Expo Go launch on physical iPhone | BLOCKED | Phone handoff did not start after the public-edge failure. |
| Server-side native request evidence | BLOCKED | No native request was expected after the public-edge failure. |
EOF
public_failure_preflight="$(dirname "$public_failure_record")/ios-preview-preflight.json"
write_preflight "$public_failure_preflight" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"FAIL","evidence":"Public manifest probe failed — no successful probe result was recorded"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
public_failure_output="$(bash "$CHECKER" "$public_failure_record" 2>&1)"
assert_contains "$public_failure_output" "validation passed"

misclassified_public_failure="$TEST_ROOT/misclassified-public-failure.md"
sed 's/\*\*Result: FAIL/\*\*Result: BLOCKED/' \
  "$public_failure_record" >"$misclassified_public_failure"
if misclassified_output="$(bash "$CHECKER" "$misclassified_public_failure" 2>&1)"; then
  printf 'A public-edge failure misclassified as missing phone evidence passed.\n' >&2
  exit 1
fi
assert_contains "$misclassified_output" "public-edge FAIL"

pass_record="$TEST_ROOT/pass/validation-record.md"
mkdir -p "$(dirname "$pass_record")"
write_record "$pass_record" <<'EOF'
# iOS SDK 57 preview validation record

**Result: PASS — physical iPhone preview handoff observed**

## Metadata

| Field | Result |
| --- | --- |
| Device model | iPhone 15 |
| iOS version | iOS 18.6 |
| Expo Go version | 2.35.7 |

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | Public manifest returned HTTP 200. |
| Local handoff probe (manifest and bundle) | PASS | Manifest and bundle returned HTTP 200. |
| Expo Go launch on physical iPhone | PASS | Landing screen rendered. |
| Server-side native request evidence | PASS | Native request evidence: platform=ios; client=Expo Go; user-agent=[redacted] |
EOF
pass_output="$(bash "$CHECKER" "$pass_record" 2>&1)"
assert_contains "$pass_output" "validation passed"

wrong_platform="$TEST_ROOT/wrong-platform.md"
sed 's/platform=ios/platform=android/' "$pass_record" >"$wrong_platform"
if wrong_platform_output="$(bash "$CHECKER" "$wrong_platform" 2>&1)"; then
  printf 'A native request with the wrong platform passed.\n' >&2
  exit 1
fi
assert_contains "$wrong_platform_output" "native iOS/Expo Go request evidence"

for status in "" GARBAGE; do
  malformed="$TEST_ROOT/malformed-${status:-blank}.md"
  sed \
    -e "s#| Public manifest reachability | PASS |.*#| Public manifest reachability | ${status} | Public result. |#" \
    "$blocked_record" >"$malformed"
  if malformed_output="$(bash "$CHECKER" "$malformed" 2>&1)"; then
    printf 'Record with public manifest status %s unexpectedly passed.\n' \
      "${status:-blank}" >&2
    exit 1
  fi
  assert_contains "$malformed_output" "Public manifest reachability"
done

empty_root="$TEST_ROOT/empty-discovery"
mkdir -p "$empty_root/scripts" "$empty_root/artifacts/chat-app/test-results/encrypted-room-recovery/ios"
cp "$CHECKER" "$empty_root/scripts/"
if missing_output="$(bash "$empty_root/scripts/check-ios-preview-evidence.sh" 2>&1)"; then
  printf 'Default discovery unexpectedly passed without an iOS preview record.\n' >&2
  exit 1
fi
assert_contains "$missing_output" "No iOS preview evidence record was found under"

printf 'iOS preview evidence regression tests passed.\n'