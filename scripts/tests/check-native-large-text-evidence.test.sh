#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-native-large-text-evidence.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assert_contains() {
  local output="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" <<<"$output"; then
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

write_review_record() {
  local root="$1"
  local platform="$2"
  local decision="$3"
  local reviewed_at="${4:-2026-09-09T13:00:00Z}"
  local build_id="${5:-build-$platform}"
  local reviewer="${6:-Ada Reviewer}"
  cat > "$root/$platform/20260909T120000Z/review-record.txt" <<EOF
platform=$platform
reviewer=$reviewer
reviewed_at_utc=$reviewed_at
candidate_build_id=$build_id
decision=$decision
notes=Checked all eleven native screenshots and both call-surface captures.
EOF
}

write_valid_run() {
  local root="$1"
  local platform="$2"
  local run_dir="$root/$platform/20260909T120000Z"
  local index

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"
  printf 'build-%s\n' "$platform" > "$run_dir/candidate-build-id.txt"
  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
candidate_build_id=build-ios
device=iPhone SE (3rd generation)
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
candidate_build_id=build-android
device_serial=emulator-5554
device_model=Smallest supported emulator
android_release=16
android_api=36
screen_dp=320x568
density_dpi=160
user_rotation=0
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
run_mode=release-gate
status=PASS
recorded_at_utc=2026-09-09T12:30:00Z
EOF
  printf '{}\n' > "$run_dir/native-info.json"
  printf '# Native branding validation\n\n- Status: **PASS**\n' > "$run_dir/native-branding-check.md"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/maestro-results.xml"
  printf '<testsuite tests="1" failures="0"></testsuite>\n' > "$run_dir/sentry-maestro-results.xml"
  cat > "$run_dir/sentry-trigger.txt" <<EOF
platform=$platform
candidate_build_id=build-$platform
marker=run-1234-$platform
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{
  "status": "PASS",
  "eventId": "0123456789abcdef0123456789abcdef",
  "platform": "$platform",
  "candidateBuildId": "build-$platform",
  "marker": "run-1234-$platform",
  "release": "chat-app@1.0.0+abc123",
  "dist": "42",
  "readableFrame": {
    "filename": "artifacts/chat-app/lib/sentry.ts",
    "function": "createNativeSourceMapProbeError",
    "line": 55,
    "column": 10
  }
}
EOF
  for index in $(seq 1 11); do
    printf 'png-%s\n' "$index" > "$run_dir/screenshots/screen-$index.png"
  done
  for index in 1 2; do
    printf 'call-%s\n' "$index" > "$run_dir/call-surface/call-$index.png"
  done
}

blocked_root="$TEST_ROOT/blocked"
mkdir -p "$blocked_root/ios" "$blocked_root/android"
printf 'Result: BLOCKED\n' > "$blocked_root/ios/runner-check.txt"
printf 'Result: BLOCKED\n' > "$blocked_root/android/runner-check.txt"
if blocked_output="$(bash "$CHECKER" "$blocked_root" 2>&1)"; then
  echo "blocked diagnostics case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$blocked_output" "[ios] Only runner-check.txt is present"
assert_contains "$blocked_output" "[android] Only runner-check.txt is present"
assert_contains "$blocked_output" "blocked runner diagnostics, not reviewed device evidence; do not record a review decision for it"

incomplete_root="$TEST_ROOT/incomplete"
write_valid_run "$incomplete_root" ios
write_valid_run "$incomplete_root" android
rm "$incomplete_root/android/20260909T120000Z/runner-metadata.txt"
: > "$incomplete_root/ios/20260909T120000Z/call-surface/call-1.png"
if incomplete_output="$(bash "$CHECKER" "$incomplete_root" 2>&1)"; then
  echo "incomplete evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$incomplete_output" "[android] Missing runner metadata and device details"
assert_contains "$incomplete_output" "[ios] Found 1 empty call-surface screenshot file(s)"

diagnostic_root="$TEST_ROOT/diagnostic"
write_valid_run "$diagnostic_root" ios
write_valid_run "$diagnostic_root" android
cat > "$diagnostic_root/ios/20260909T120000Z/pass-fail-record.txt" <<EOF
platform=ios
run_mode=diagnostic-only
status=PASS
EOF
cat > "$diagnostic_root/android/20260909T120000Z/pass-fail-record.txt" <<EOF
platform=android
status=PASS
EOF
if diagnostic_output="$(bash "$CHECKER" "$diagnostic_root" 2>&1)"; then
  echo "diagnostic-only evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$diagnostic_output" "[ios] The pass/fail record at"
assert_contains "$diagnostic_output" "is from a diagnostic-only run (NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1), not release evidence"
assert_contains "$diagnostic_output" "[android] The pass/fail record at"
assert_contains "$diagnostic_output" "does not declare run_mode=release-gate"

unmapped_root="$TEST_ROOT/unmapped"
write_valid_run "$unmapped_root" ios
write_valid_run "$unmapped_root" android
node --input-type=module - "$unmapped_root/android/20260909T120000Z/sentry-source-map-evidence.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const evidence = JSON.parse(readFileSync(path, "utf8"));
evidence.readableFrame.filename = "app:///index.android.bundle";
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
if unmapped_output="$(bash "$CHECKER" "$unmapped_root" 2>&1)"; then
  echo "unmapped Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$unmapped_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$unmapped_output" "readable source-mapped frame is missing"

wrong_function_root="$TEST_ROOT/wrong-function"
write_valid_run "$wrong_function_root" ios
write_valid_run "$wrong_function_root" android
node --input-type=module - "$wrong_function_root/android/20260909T120000Z/sentry-source-map-evidence.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const evidence = JSON.parse(readFileSync(path, "utf8"));
evidence.readableFrame.function = "someOtherMappedFunction";
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
if wrong_function_output="$(bash "$CHECKER" "$wrong_function_root" 2>&1)"; then
  echo "wrong-function Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$wrong_function_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$wrong_function_output" "readable source-mapped frame is missing"

valid_root="$TEST_ROOT/valid"
write_valid_run "$valid_root" ios
write_valid_run "$valid_root" android
for platform in ios android; do
  cat > "$valid_root/$platform/20260909T120000Z/review-record.template.txt" <<EOF
# After reviewing this run, replace every placeholder and rename this file to review-record.txt.
platform=$platform
reviewer=<full name or handle>
reviewed_at_utc=<output of: date -u +%Y-%m-%dT%H:%M:%SZ>
candidate_build_id=build-$platform
decision=<APPROVED or REJECTED>
notes=<optional one-line summary of platform-specific findings>
EOF
done
valid_output="$(bash "$CHECKER" "$valid_root" 2>&1)"
assert_contains "$valid_output" "passed for iOS and Android"
assert_contains "$valid_output" "[ios] Review record missing: $valid_root/ios/20260909T120000Z/review-record.txt does not exist"
assert_contains "$valid_output" "[android] Review record missing: $valid_root/android/20260909T120000Z/review-record.txt does not exist"
assert_contains "$valid_output" "Review pending for: ios android"
assert_contains "$valid_output" "complete review-record.template.txt and rename it to review-record.txt"
assert_not_contains "$valid_output" "Review record: APPROVED"

if strict_missing_output="$(NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 bash "$CHECKER" "$valid_root" 2>&1)"; then
  echo "strict missing-review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$strict_missing_output" "Strict review mode enabled"
assert_contains "$strict_missing_output" "[ios] Required approval missing:"
assert_contains "$strict_missing_output" "[android] Required approval missing:"
assert_contains "$strict_missing_output" "completeness check FAILED with 2 issue(s)"

reviewed_root="$TEST_ROOT/reviewed"
write_valid_run "$reviewed_root" ios
write_valid_run "$reviewed_root" android
write_review_record "$reviewed_root" ios APPROVED
write_review_record "$reviewed_root" android APPROVED "2026-09-09T14:45:00Z" build-android "Grace Reviewer"
reviewed_output="$(bash "$CHECKER" "$reviewed_root" 2>&1)"
assert_contains "$reviewed_output" "passed for iOS and Android"
assert_contains "$reviewed_output" "[ios] Review record: APPROVED by Ada Reviewer at 2026-09-09T13:00:00Z for candidate build-ios."
assert_contains "$reviewed_output" "[android] Review record: APPROVED by Grace Reviewer at 2026-09-09T14:45:00Z for candidate build-android."
assert_not_contains "$reviewed_output" "Review record missing"
assert_not_contains "$reviewed_output" "Review pending"

strict_reviewed_output="$(
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 bash "$CHECKER" "$reviewed_root" 2>&1
)"
assert_contains "$strict_reviewed_output" "Strict review mode enabled"
assert_contains "$strict_reviewed_output" "[ios] Review record: APPROVED"
assert_contains "$strict_reviewed_output" "[android] Review record: APPROVED"
assert_contains "$strict_reviewed_output" "passed for iOS and Android"

candidate_scoped_root="$TEST_ROOT/candidate-scoped-rerun"
write_valid_run "$candidate_scoped_root" ios
write_valid_run "$candidate_scoped_root" android
write_review_record "$candidate_scoped_root" ios APPROVED "2026-09-09T13:00:00Z"
write_review_record "$candidate_scoped_root" android APPROVED "2026-09-09T13:00:00Z"
printf 'approval_scope=candidate\n' >> "$candidate_scoped_root/ios/20260909T120000Z/review-record.txt"
printf 'approval_scope=candidate\n' >> "$candidate_scoped_root/android/20260909T120000Z/review-record.txt"
mv "$candidate_scoped_root/ios/20260909T120000Z" "$candidate_scoped_root/ios/20260910T120000Z"
mv "$candidate_scoped_root/android/20260909T120000Z" "$candidate_scoped_root/android/20260910T120000Z"
candidate_scoped_output="$(
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 bash "$CHECKER" "$candidate_scoped_root" 2>&1
)"
assert_contains "$candidate_scoped_output" "[ios] Review record: APPROVED"
assert_contains "$candidate_scoped_output" "[android] Review record: APPROVED"
assert_contains "$candidate_scoped_output" "passed for iOS and Android"

if invalid_mode_output="$(NATIVE_EVIDENCE_REQUIRE_APPROVAL=yes bash "$CHECKER" "$reviewed_root" 2>&1)"; then
  echo "invalid strict-mode value unexpectedly passed" >&2
  exit 1
fi
assert_contains "$invalid_mode_output" "NATIVE_EVIDENCE_REQUIRE_APPROVAL must be 0 or 1."

rejected_root="$TEST_ROOT/rejected"
write_valid_run "$rejected_root" ios
write_valid_run "$rejected_root" android
write_review_record "$rejected_root" ios APPROVED
write_review_record "$rejected_root" android REJECTED
if rejected_output="$(bash "$CHECKER" "$rejected_root" 2>&1)"; then
  echo "rejected review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$rejected_output" "[android] The review record at $rejected_root/android/20260909T120000Z/review-record.txt records decision=REJECTED by Ada Reviewer at 2026-09-09T13:00:00Z (notes: Checked all eleven native screenshots and both call-surface captures.)."
assert_contains "$rejected_output" "A rejected review blocks release"
assert_contains "$rejected_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$rejected_output" "[ios] Review record missing"

mismatched_root="$TEST_ROOT/mismatched"
write_valid_run "$mismatched_root" ios
write_valid_run "$mismatched_root" android
write_review_record "$mismatched_root" ios APPROVED "2026-09-09T13:00:00Z" build-previous-candidate
write_review_record "$mismatched_root" android APPROVED "2026-09-09T12:10:00Z"
if mismatched_output="$(bash "$CHECKER" "$mismatched_root" 2>&1)"; then
  echo "mismatched review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$mismatched_output" "[ios] Review record candidate_build_id 'build-previous-candidate' does not match the tested candidate 'build-ios'"
assert_contains "$mismatched_output" "[android] Review record reviewed_at_utc 2026-09-09T12:10:00Z predates the evidence recorded at 2026-09-09T12:30:00Z"
assert_contains "$mismatched_output" "completeness check FAILED with 2 issue(s)"

malformed_root="$TEST_ROOT/malformed"
write_valid_run "$malformed_root" ios
write_valid_run "$malformed_root" android
write_review_record "$malformed_root" ios MAYBE "September 9" build-ios "<full name or handle>"
: > "$malformed_root/android/20260909T120000Z/review-record.txt"
if malformed_output="$(bash "$CHECKER" "$malformed_root" 2>&1)"; then
  echo "malformed review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$malformed_output" "[ios] Review record still contains the template placeholder for reviewer"
assert_contains "$malformed_output" "[ios] Review record reviewed_at_utc 'September 9'"
assert_contains "$malformed_output" "[ios] Review record decision 'MAYBE'"
assert_contains "$malformed_output" "[android] Empty review record: $malformed_root/android/20260909T120000Z/review-record.txt"
assert_contains "$malformed_output" "completeness check FAILED with 4 issue(s)"

wrong_platform_root="$TEST_ROOT/wrong-platform"
write_valid_run "$wrong_platform_root" ios
write_valid_run "$wrong_platform_root" android
write_review_record "$wrong_platform_root" ios APPROVED
write_review_record "$wrong_platform_root" android APPROVED
printf 'platform=ios\nreviewer=Ada Reviewer\nreviewed_at_utc=2026-09-09T13:00:00Z\ncandidate_build_id=build-android\ndecision=APPROVED\n' \
  > "$wrong_platform_root/android/20260909T120000Z/review-record.txt"
if wrong_platform_output="$(bash "$CHECKER" "$wrong_platform_root" 2>&1)"; then
  echo "wrong-platform review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$wrong_platform_output" "[android] Review record identifies platform 'ios', not 'android'"

echo "Native large-text evidence completeness regression tests passed."