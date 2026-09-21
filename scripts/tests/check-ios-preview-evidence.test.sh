#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-ios-preview-evidence.sh"
HANDOFF_DOC="$ROOT_DIR/artifacts/chat-app/docs/native-room-key-persistence-device-check.md"
VALIDATOR="$ROOT_DIR/artifacts/chat-app/scripts/validate-preview-startup.mjs"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "iOS preview evidence test cleanup escaped its fixture directory" >&2
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

handoff_doc="$(cat "$HANDOFF_DOC")"
assert_contains "$handoff_doc" 'artifacts/chat-app/.expo/dev-request-evidence.log'
assert_contains "$handoff_doc" 'The command reads the retained `.expo/dev-request-evidence.log` by default'
assert_contains "$handoff_doc" 'EXPO_DEV_REQUEST_EVIDENCE_FILE'
assert_contains "$handoff_doc" '--source <path>'
assert_contains "$handoff_doc" '--timestamp "$(date -u +%Y%m%dT%H%M%SZ)"'
assert_contains "$handoff_doc" 'artifacts/chat-app/test-results/encrypted-room-recovery/ios/<UTC timestamp>'
assert_contains "$handoff_doc" 'platform=ios client=Expo Go'
assert_contains "$handoff_doc" 'excluding `OPTIONS`'
assert_contains "$handoff_doc" 'logs/native-ios-request-evidence.txt'
assert_contains "$handoff_doc" 'never contain a host, URL, query string,'
assert_contains "$handoff_doc" 'credentials, account data, or message content'
assert_contains "$handoff_doc" 'do not retain the full host, URL, credentials, account identifiers, or'
assert_contains "$handoff_doc" 'message content'
assert_contains "$handoff_doc" 'Browser and curl probes retain their own client classes and'
assert_contains "$handoff_doc" 'do not qualify as native iPhone evidence.'

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
| Public manifest reachability | PASS | public manifest HTTP 200 (128 bytes) |
| Local handoff probe (manifest and bundle) | NOT_RUN | Local manifest/bundle probe not run — no successful probe result was recorded |
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

json_contract_root="$TEST_ROOT/json-contract"
json_contract_record="$json_contract_root/validation-record.md"
mkdir -p "$json_contract_root"
cp "$blocked_record" "$json_contract_record"
json_contract_path="$json_contract_root/ios-preview-preflight.json"

invalid_schema_sentinel="ios-preview-schema-tampered"
cat >"$json_contract_path" <<EOF
{"schema":"$invalid_schema_sentinel","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if invalid_schema_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON with an invalid schema unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$invalid_schema_output" "does not satisfy the redacted schema"
assert_not_contains "$invalid_schema_output" "$invalid_schema_sentinel"

truncated_json_sentinel="ios-preview-truncated-preflight-sentinel"
cat >"$json_contract_path" <<EOF
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"$truncated_json_sentinel"
EOF
if truncated_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Truncated iOS preflight JSON unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$truncated_json_output" "does not satisfy the redacted schema"
assert_not_contains "$truncated_json_output" "$truncated_json_sentinel"
if truncated_json_direct_output="$(
  node "$VALIDATOR" --validate-record "$json_contract_path" 2>&1
)"; then
  printf 'Truncated iOS preflight JSON unexpectedly passed direct validation.\n' >&2
  exit 1
fi
assert_contains "$truncated_json_direct_output" \
  "Preview handoff preflight JSON is not valid JSON."
assert_not_contains "$truncated_json_direct_output" "$truncated_json_sentinel"

non_json_sentinel="ios-preview-non-json-preflight-sentinel"
cat >"$json_contract_path" <<EOF
$non_json_sentinel
This is not a JSON preflight record.
EOF
if non_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Non-JSON iOS preflight content unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$non_json_output" "does not satisfy the redacted schema"
assert_not_contains "$non_json_output" "$non_json_sentinel"
if non_json_direct_output="$(
  node "$VALIDATOR" --validate-record "$json_contract_path" 2>&1
)"; then
  printf 'Non-JSON iOS preflight content unexpectedly passed direct validation.\n' >&2
  exit 1
fi
assert_contains "$non_json_direct_output" \
  "Preview handoff preflight JSON is not valid JSON."
assert_not_contains "$non_json_direct_output" "$non_json_sentinel"

duplicate_json_sentinel="ios-duplicate-preflight-secret"
cat >"$json_contract_path" <<EOF
{"schema":"ios-preview-handoff-preflight/v1","schema":"$duplicate_json_sentinel","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","status":"FAIL","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if duplicate_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON with duplicate fields unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$duplicate_json_output" "does not satisfy the redacted schema"
assert_not_contains "$duplicate_json_output" "$duplicate_json_sentinel"
if duplicate_json_direct_output="$(
  node "$VALIDATOR" --validate-record "$json_contract_path" 2>&1
)"; then
  printf 'Duplicate-field iOS preflight JSON unexpectedly passed direct validation.\n' >&2
  exit 1
fi
assert_contains "$duplicate_json_direct_output" \
  "Preview handoff preflight JSON contains duplicate fields."
assert_not_contains "$duplicate_json_direct_output" "$duplicate_json_sentinel"

cat >"$json_contract_path" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"GARBAGE","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if invalid_status_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON with an invalid boundary status unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$invalid_status_output" "does not satisfy the redacted schema"
assert_not_contains "$invalid_status_output" "GARBAGE"

unsafe_json_sentinel="https://preview-fixture.replit.dev/account=fixture-account/message=fixture-message"
cat >"$json_contract_path" <<EOF
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"$unsafe_json_sentinel"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"safe"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if unsafe_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON with unsafe evidence unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$unsafe_json_output" "does not satisfy the redacted schema"
assert_not_contains "$unsafe_json_output" "$unsafe_json_sentinel"

cat >"$json_contract_path" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"FAIL","evidence":"Public manifest probe failed — no successful probe result was recorded"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if public_mismatch_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON public-edge mismatch unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$public_mismatch_output" "public manifest boundary does not match"

cat >"$json_contract_path" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"FAIL","evidence":"Local manifest/bundle probe failed — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if local_mismatch_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'iOS preflight JSON local-probe mismatch unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$local_mismatch_output" "local handoff boundary does not match"

cat >"$json_contract_path" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
json_contract_valid_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"
assert_contains "$json_contract_valid_output" "validation passed"

public_failure_record="$TEST_ROOT/public-failure/validation-record.md"
mkdir -p "$(dirname "$public_failure_record")"
write_record "$public_failure_record" <<'EOF'
# iOS SDK 57 preview validation record

**Result: FAIL — public Expo preview edge was unavailable**

| Handoff boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | FAIL | Public manifest probe failed — no successful probe result was recorded |
| Local handoff probe (manifest and bundle) | NOT_RUN | Local manifest/bundle probe not run — no successful probe result was recorded |
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
| Public manifest reachability | PASS | public manifest HTTP 200 (128 bytes) |
| Local handoff probe (manifest and bundle) | PASS | manifest HTTP 200 (64 bytes); bundle HTTP 200 (4096 bytes) |
| Expo Go launch on physical iPhone | PASS | Landing screen rendered. |
| Server-side native request evidence | PASS | Native request evidence: platform=ios; client=Expo Go; user-agent=[redacted] |
EOF
pass_preflight="$(dirname "$pass_record")/ios-preview-preflight.json"
write_preflight "$pass_preflight" <<'EOF'
{"schema":"ios-preview-handoff-preflight/v1","platform":"ios","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"PASS","evidence":"manifest HTTP 200 (64 bytes); bundle HTTP 200 (4096 bytes)"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical iPhone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
pass_output="$(bash "$CHECKER" "$pass_record" 2>&1)"
assert_contains "$pass_output" "validation passed"

tampered_byte_count="$TEST_ROOT/pass/tampered-byte-count.md"
cp "$pass_record" "$tampered_byte_count"
sed -i 's/public manifest HTTP 200 (128 bytes)/public manifest HTTP 200 (129 bytes)/' \
  "$pass_preflight"
if tampered_byte_output="$(bash "$CHECKER" "$tampered_byte_count" 2>&1)"; then
  printf 'iOS preflight JSON with a tampered public byte count unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$tampered_byte_output" \
  "preflight JSON public manifest evidence does not match"
sed -i 's/public manifest HTTP 200 (129 bytes)/public manifest HTTP 200 (128 bytes)/' \
  "$pass_preflight"

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

cleanup_test_fixtures
trap - EXIT

printf 'iOS preview evidence regression tests passed.\n'