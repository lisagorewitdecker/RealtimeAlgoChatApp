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

release_node_range="$(node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs";
console.log(JSON.parse(readFileSync("package.json", "utf8")).engines?.node ?? "");
NODE
)"
expected_release_node_range='>=24.0.0 <25.0.0'
if [[ "$release_node_range" != "$expected_release_node_range" ]]; then
  printf 'Expected package.json to define the release Node range as %s; got %s\n' \
    "$expected_release_node_range" "$release_node_range" >&2
  exit 1
fi
release_node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$release_node_major" != "24" ]]; then
  printf 'Native evidence privacy regression must run on a supported Node 24 runtime; got %s\n' \
    "$(node --version)" >&2
  exit 1
fi

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
  # Mirror every field the native large-text runner writes, so duplicate-field
  # coverage tracks the real producer rather than a minimal subset.
  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
run_mode=release-gate
candidate_build_id=build-ios
app_id=com.example.chat
device=iPhone SE (3rd generation)
device_udid=00000000-0000-0000-0000-000000000000
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
run_mode=release-gate
candidate_build_id=build-android
app_id=com.example.chat
device_serial=emulator-5554
device_model=Smallest supported emulator
android_release=16
android_api=36
screen_px=320x568
screen_dp=320x568
density_dpi=160
user_rotation=0
recorded_at_utc=2026-09-09T12:00:00Z
EOF
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
run_mode=release-gate
candidate_build_id=build-$platform
status=PASS
native_screenshot_count=11
call_surface_screenshot_count=2
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

metadata_keys_of() {
  cut -d= -f1 "$1"
}

# Appends a conflicting second declaration for every key already in the file.
append_conflicting_duplicates() {
  local metadata_path="$1"
  local conflicting_lines
  conflicting_lines="$(awk -F= '{ print $1 "=must-not-be-printed-" NR }' "$metadata_path")"
  printf '%s\n' "$conflicting_lines" >> "$metadata_path"
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
# Keep notes=... for an optional one-line summary, or use this block for detailed findings.
notes<<END_NOTES
<optional multi-line findings; headings, bullets, links, and backticks are stored literally>
END_NOTES
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
assert_contains "$reviewed_output" "[ios] Review record: APPROVED for the validated candidate."
assert_contains "$reviewed_output" "[android] Review record: APPROVED for the validated candidate."
assert_not_contains "$reviewed_output" "Grace Reviewer"
assert_not_contains "$reviewed_output" "build-android"
assert_not_contains "$reviewed_output" "Review record missing"
assert_not_contains "$reviewed_output" "Review pending"

strict_reviewed_output="$(
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 bash "$CHECKER" "$reviewed_root" 2>&1
)"
assert_contains "$strict_reviewed_output" "Strict review mode enabled"
assert_contains "$strict_reviewed_output" "[ios] Review record: APPROVED"
assert_contains "$strict_reviewed_output" "[android] Review record: APPROVED"
assert_contains "$strict_reviewed_output" "passed for iOS and Android"

crlf_approved_root="$TEST_ROOT/crlf-approved"
write_valid_run "$crlf_approved_root" ios
write_valid_run "$crlf_approved_root" android
write_review_record "$crlf_approved_root" ios APPROVED
printf '%s\r\n' \
  'platform=android' \
  'reviewer=Ada Reviewer' \
  'reviewed_at_utc=2026-09-09T13:00:00Z' \
  'candidate_build_id=build-android' \
  'decision=APPROVED' \
  'notes<<END_NOTES' \
  '# Layout verified' \
  '- The `Send` button remains visible.' \
  '- See [capture](screenshots/screen-11.png).' \
  'END_NOTES' \
  > "$crlf_approved_root/android/20260909T120000Z/review-record.txt"
crlf_approved_output="$(bash "$CHECKER" "$crlf_approved_root" 2>&1)"
assert_contains "$crlf_approved_output" "[android] Review record: APPROVED for the validated candidate."
assert_contains "$crlf_approved_output" "passed for iOS and Android"
assert_not_contains "$crlf_approved_output" "unterminated notes block"

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
assert_contains "$rejected_output" "[android] The review record at $rejected_root/android/20260909T120000Z/review-record.txt records a rejected decision."
assert_contains "$rejected_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$rejected_output" "A rejected review blocks release"
assert_contains "$rejected_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$rejected_output" "[ios] Review record missing"

multiline_rejected_root="$TEST_ROOT/multiline-rejected"
write_valid_run "$multiline_rejected_root" ios
write_valid_run "$multiline_rejected_root" android
write_review_record "$multiline_rejected_root" ios APPROVED
printf '%s\r\n' \
  'platform=android' \
  'reviewer=Ada Reviewer' \
  'reviewed_at_utc=2026-09-09T13:00:00Z' \
  'candidate_build_id=build-android' \
  'decision=REJECTED' \
  'notes<<END_NOTES' \
  '# Layout finding' \
  '- The `Send` button overlaps the final line.' \
  '' \
  '  - See [capture](screenshots/screen-11.png).' \
  'END_NOTES' \
  > "$multiline_rejected_root/android/20260909T120000Z/review-record.txt"
if multiline_rejected_output="$(bash "$CHECKER" "$multiline_rejected_root" 2>&1)"; then
  echo "multi-line rejected review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$multiline_rejected_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$multiline_rejected_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$multiline_rejected_output" $'\r'
assert_not_contains "$multiline_rejected_output" "unterminated notes block"
assert_not_contains "$multiline_rejected_output" "The \`Send\` button overlaps"
assert_not_contains "$multiline_rejected_output" "screenshots/screen-11.png"

privacy_rejected_root="$TEST_ROOT/privacy-rejected"
write_valid_run "$privacy_rejected_root" ios
write_valid_run "$privacy_rejected_root" android
write_review_record "$privacy_rejected_root" ios APPROVED
review_note_credential='Bearer native-review-token-credential'
review_note_marker='native-review-fixture-marker-20260909'
cat > "$privacy_rejected_root/android/20260909T120000Z/review-record.txt" <<EOF
platform=android
reviewer=Ada Reviewer
reviewed_at_utc=2026-09-09T13:00:00Z
candidate_build_id=build-android
decision=REJECTED
notes=The failing fixture included ${review_note_credential} and ${review_note_marker}.
EOF
if privacy_rejected_output="$(bash "$CHECKER" "$privacy_rejected_root" 2>&1)"; then
  echo "private rejected review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$privacy_rejected_output" "[android] The review record at $privacy_rejected_root/android/20260909T120000Z/review-record.txt records a rejected decision."
assert_contains "$privacy_rejected_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$privacy_rejected_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$privacy_rejected_output" "$review_note_credential"
assert_not_contains "$privacy_rejected_output" "$review_note_marker"

conflicting_notes_root="$TEST_ROOT/conflicting-notes"
write_valid_run "$conflicting_notes_root" ios
write_valid_run "$conflicting_notes_root" android
write_review_record "$conflicting_notes_root" ios APPROVED
write_review_record "$conflicting_notes_root" android REJECTED
cat >> "$conflicting_notes_root/android/20260909T120000Z/review-record.txt" <<'EOF'
notes<<FINDINGS
This content must not be selected or printed.
FINDINGS
EOF
if conflicting_notes_output="$(bash "$CHECKER" "$conflicting_notes_root" 2>&1)"; then
  echo "conflicting notes declarations case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$conflicting_notes_output" "[android] Review record has 2 notes declarations"
assert_contains "$conflicting_notes_output" "Use exactly one notes=... line or one notes<<... block so the review finding is unambiguous."
assert_not_contains "$conflicting_notes_output" "This content must not be selected or printed."
assert_not_contains "$conflicting_notes_output" "[android] Review notes (literal evidence):"
assert_contains "$conflicting_notes_output" "completeness check FAILED with 2 issue(s)"

duplicate_notes_blocks_root="$TEST_ROOT/duplicate-notes-blocks"
write_valid_run "$duplicate_notes_blocks_root" ios
write_valid_run "$duplicate_notes_blocks_root" android
write_review_record "$duplicate_notes_blocks_root" ios APPROVED
cat > "$duplicate_notes_blocks_root/android/20260909T120000Z/review-record.txt" <<'EOF'
platform=android
reviewer=Ada Reviewer
reviewed_at_utc=2026-09-09T13:00:00Z
candidate_build_id=build-android
decision=APPROVED
notes<<FIRST
First finding.
FIRST
notes<<SECOND
Second finding.
SECOND
EOF
if duplicate_notes_blocks_output="$(bash "$CHECKER" "$duplicate_notes_blocks_root" 2>&1)"; then
  echo "duplicate notes blocks case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$duplicate_notes_blocks_output" "[android] Review record has 2 notes declarations"
assert_contains "$duplicate_notes_blocks_output" "completeness check FAILED with 1 issue(s)"

duplicate_single_values_root="$TEST_ROOT/duplicate-single-values"
write_valid_run "$duplicate_single_values_root" ios
write_valid_run "$duplicate_single_values_root" android
write_review_record "$duplicate_single_values_root" ios APPROVED
write_review_record "$duplicate_single_values_root" android APPROVED
cat >> "$duplicate_single_values_root/android/20260909T120000Z/review-record.txt" <<'EOF'
platform=ios
reviewer=Conflicting Reviewer
reviewed_at_utc=not-a-timestamp
candidate_build_id=another-build
decision=REJECTED
approval_scope=candidate
approval_scope=unsupported
EOF
if duplicate_single_values_output="$(bash "$CHECKER" "$duplicate_single_values_root" 2>&1)"; then
  echo "duplicate single-value review fields case unexpectedly passed" >&2
  exit 1
fi
for duplicated_field in platform reviewer reviewed_at_utc candidate_build_id decision approval_scope; do
  assert_contains "$duplicate_single_values_output" "[android] Review record has 2 ${duplicated_field} declarations"
  assert_contains "$duplicate_single_values_output" "Declare ${duplicated_field}=... at most once so the review record is unambiguous."
done
assert_contains "$duplicate_single_values_output" "completeness check FAILED with 6 issue(s)"
assert_not_contains "$duplicate_single_values_output" "Conflicting Reviewer"
assert_not_contains "$duplicate_single_values_output" "not-a-timestamp"
assert_not_contains "$duplicate_single_values_output" "another-build"
assert_not_contains "$duplicate_single_values_output" "decision=REJECTED by"
assert_not_contains "$duplicate_single_values_output" "approval_scope '"
assert_not_contains "$duplicate_single_values_output" "identifies platform"

# Every generated field in runner-metadata.txt and pass-fail-record.txt is
# duplicated with a conflicting value on both platforms. Each duplicate must be
# named without selecting, comparing, or printing either value.
duplicate_machine_metadata_root="$TEST_ROOT/duplicate-machine-metadata"
write_valid_run "$duplicate_machine_metadata_root" ios
write_valid_run "$duplicate_machine_metadata_root" android
expected_duplicate_issues=0
for platform in ios android; do
  for metadata_file in runner-metadata.txt pass-fail-record.txt; do
    metadata_path="$duplicate_machine_metadata_root/$platform/20260909T120000Z/$metadata_file"
    expected_duplicate_issues=$((expected_duplicate_issues + $(metadata_keys_of "$metadata_path" | wc -l)))
    append_conflicting_duplicates "$metadata_path"
  done
done
if duplicate_machine_metadata_output="$(bash "$CHECKER" "$duplicate_machine_metadata_root" 2>&1)"; then
  echo "duplicate machine metadata case unexpectedly passed" >&2
  exit 1
fi
for platform in ios android; do
  runner_metadata_path="$duplicate_machine_metadata_root/$platform/20260909T120000Z/runner-metadata.txt"
  for duplicated_field in $(metadata_keys_of "$runner_metadata_path" | sort -u); do
    assert_contains "$duplicate_machine_metadata_output" "[$platform] Runner metadata has 2 ${duplicated_field} declarations in ${runner_metadata_path}."
    assert_contains "$duplicate_machine_metadata_output" "Declare ${duplicated_field}=... at most once so the runner metadata is unambiguous"
  done
  pass_fail_path="$duplicate_machine_metadata_root/$platform/20260909T120000Z/pass-fail-record.txt"
  for duplicated_field in $(metadata_keys_of "$pass_fail_path" | sort -u); do
    assert_contains "$duplicate_machine_metadata_output" "[$platform] Pass/fail record has 2 ${duplicated_field} declarations in ${pass_fail_path}."
    assert_contains "$duplicate_machine_metadata_output" "Declare ${duplicated_field}=... at most once so the pass/fail record is unambiguous"
  done
done
# Fields the producer writes but the checker never validates by value must be
# covered too, not just the fields that feed a comparison.
for duplicated_field in run_mode app_id device_udid; do
  assert_contains "$duplicate_machine_metadata_output" "[ios] Runner metadata has 2 ${duplicated_field} declarations"
done
for duplicated_field in run_mode app_id screen_px device_model android_release android_api screen_dp density_dpi user_rotation; do
  assert_contains "$duplicate_machine_metadata_output" "[android] Runner metadata has 2 ${duplicated_field} declarations"
done
for duplicated_field in candidate_build_id native_screenshot_count call_surface_screenshot_count; do
  assert_contains "$duplicate_machine_metadata_output" "[ios] Pass/fail record has 2 ${duplicated_field} declarations"
  assert_contains "$duplicate_machine_metadata_output" "[android] Pass/fail record has 2 ${duplicated_field} declarations"
done
assert_contains "$duplicate_machine_metadata_output" "completeness check FAILED with ${expected_duplicate_issues} issue(s)"
assert_not_contains "$duplicate_machine_metadata_output" "must-not-be-printed"
assert_not_contains "$duplicate_machine_metadata_output" "Runner metadata identifies platform"
assert_not_contains "$duplicate_machine_metadata_output" "Runner metadata is missing"
assert_not_contains "$duplicate_machine_metadata_output" "is not PASS"
assert_not_contains "$duplicate_machine_metadata_output" "does not declare run_mode=release-gate"
assert_not_contains "$duplicate_machine_metadata_output" "is from a diagnostic-only run"

# Conflicting Sentry trigger fields must be rejected without selecting,
# comparing, or printing either declaration.
duplicate_sentry_trigger_root="$TEST_ROOT/duplicate-sentry-trigger"
write_valid_run "$duplicate_sentry_trigger_root" ios
write_valid_run "$duplicate_sentry_trigger_root" android
expected_sentry_trigger_issues=0
for platform in ios android; do
  sentry_trigger_path="$duplicate_sentry_trigger_root/$platform/20260909T120000Z/sentry-trigger.txt"
  expected_sentry_trigger_issues=$((expected_sentry_trigger_issues + $(metadata_keys_of "$sentry_trigger_path" | wc -l)))
  append_conflicting_duplicates "$sentry_trigger_path"
done
if duplicate_sentry_trigger_output="$(bash "$CHECKER" "$duplicate_sentry_trigger_root" 2>&1)"; then
  echo "duplicate Sentry trigger metadata case unexpectedly passed" >&2
  exit 1
fi
for platform in ios android; do
  sentry_trigger_path="$duplicate_sentry_trigger_root/$platform/20260909T120000Z/sentry-trigger.txt"
  for duplicated_field in $(metadata_keys_of "$sentry_trigger_path" | sort -u); do
    assert_contains "$duplicate_sentry_trigger_output" "[$platform] Sentry trigger metadata has 2 ${duplicated_field} declarations in ${sentry_trigger_path}."
    assert_contains "$duplicate_sentry_trigger_output" "Declare ${duplicated_field}=... at most once so the Sentry trigger metadata is unambiguous"
  done
done
assert_contains "$duplicate_sentry_trigger_output" "completeness check FAILED with ${expected_sentry_trigger_issues} issue(s)"
assert_not_contains "$duplicate_sentry_trigger_output" "must-not-be-printed"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger platform does not match"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger candidate build ID does not match"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger marker does not match"

# Conflicting Sentry evidence fields must be rejected before JSON.parse can
# select the later declaration, without exposing either field value.
duplicate_sentry_evidence_root="$TEST_ROOT/duplicate-sentry-evidence"
write_valid_run "$duplicate_sentry_evidence_root" ios
write_valid_run "$duplicate_sentry_evidence_root" android
for platform in ios android; do
  sentry_evidence_path="$duplicate_sentry_evidence_root/$platform/20260909T120000Z/sentry-source-map-evidence.json"
  node --input-type=module - "$sentry_evidence_path" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
let evidence = readFileSync(path, "utf8");
for (const field of ["status", "platform", "candidateBuildId", "marker"]) {
  const fieldPattern = new RegExp(`(\\n  "${field}": "[^"]+",)`);
  evidence = evidence.replace(
    fieldPattern,
    `$1\n  "${field}": "must-not-be-printed-${field}",`,
  );
}
writeFileSync(path, evidence);
NODE
done
if duplicate_sentry_evidence_output="$(bash "$CHECKER" "$duplicate_sentry_evidence_root" 2>&1)"; then
  echo "duplicate Sentry source-map evidence case unexpectedly passed" >&2
  exit 1
fi
for platform in ios android; do
  assert_contains "$duplicate_sentry_evidence_output" "[$platform] Invalid Sentry source-map evidence"
  assert_contains "$duplicate_sentry_evidence_output" "duplicate JSON field(s): status, platform, candidateBuildId, marker"
done
assert_contains "$duplicate_sentry_evidence_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$duplicate_sentry_evidence_output" "must-not-be-printed"

# Malformed and unknown Sentry trigger lines must not be ignored alongside
# otherwise valid metadata, and diagnostics must not expose their values.
malformed_sentry_trigger_root="$TEST_ROOT/malformed-sentry-trigger"
write_valid_run "$malformed_sentry_trigger_root" ios
write_valid_run "$malformed_sentry_trigger_root" android
credential_like_trigger_value='Bearer sentry-release-token-credential'
marker_like_trigger_value='sentry-trigger-marker-release-20260909'
cat >> "$malformed_sentry_trigger_root/ios/20260909T120000Z/sentry-trigger.txt" <<EOF
not-a-declaration-with-${credential_like_trigger_value}
unknown=${marker_like_trigger_value}
too_many_separators=secret=second-secret
=missing-key-secret-value
empty-value=
EOF
android_credential_like_trigger_value='Bearer android-sentry-release-token-credential'
android_marker_like_trigger_value='android-sentry-trigger-marker-release-20260909'
cat >> "$malformed_sentry_trigger_root/android/20260909T120000Z/sentry-trigger.txt" <<EOF
not-an-android-declaration-with-${android_credential_like_trigger_value}
unknown=${android_marker_like_trigger_value}
android-too_many_separators=secret=android-second-secret
=android-missing-key-secret
android-empty-value=
EOF
if malformed_sentry_trigger_output="$(bash "$CHECKER" "$malformed_sentry_trigger_root" 2>&1)"; then
  echo "malformed Sentry trigger metadata case unexpectedly passed" >&2
  exit 1
fi
malformed_sentry_trigger_path="$malformed_sentry_trigger_root/ios/20260909T120000Z/sentry-trigger.txt"
assert_contains "$malformed_sentry_trigger_output" "[ios] Sentry trigger metadata line 4 in ${malformed_sentry_trigger_path} is malformed: expected exactly one key=value declaration."
assert_contains "$malformed_sentry_trigger_output" "[ios] Sentry trigger metadata line 5 in ${malformed_sentry_trigger_path} is malformed: unknown key/value declaration."
assert_contains "$malformed_sentry_trigger_output" "[ios] Sentry trigger metadata line 6 in ${malformed_sentry_trigger_path} is malformed: expected exactly one key=value declaration."
assert_contains "$malformed_sentry_trigger_output" "[ios] Sentry trigger metadata line 7 in ${malformed_sentry_trigger_path} is malformed: key and value must both be non-empty."
assert_contains "$malformed_sentry_trigger_output" "[ios] Sentry trigger metadata line 8 in ${malformed_sentry_trigger_path} is malformed: key and value must both be non-empty."
assert_contains "$malformed_sentry_trigger_output" "completeness check FAILED with 10 issue(s)"
assert_not_contains "$malformed_sentry_trigger_output" "$credential_like_trigger_value"
assert_not_contains "$malformed_sentry_trigger_output" "$marker_like_trigger_value"
assert_not_contains "$malformed_sentry_trigger_output" "second-secret"
malformed_android_sentry_trigger_path="$malformed_sentry_trigger_root/android/20260909T120000Z/sentry-trigger.txt"
assert_contains "$malformed_sentry_trigger_output" "[android] Sentry trigger metadata line 4 in ${malformed_android_sentry_trigger_path} is malformed: expected exactly one key=value declaration."
assert_contains "$malformed_sentry_trigger_output" "[android] Sentry trigger metadata line 5 in ${malformed_android_sentry_trigger_path} is malformed: unknown key/value declaration."
assert_contains "$malformed_sentry_trigger_output" "[android] Sentry trigger metadata line 6 in ${malformed_android_sentry_trigger_path} is malformed: expected exactly one key=value declaration."
assert_contains "$malformed_sentry_trigger_output" "[android] Sentry trigger metadata line 7 in ${malformed_android_sentry_trigger_path} is malformed: key and value must both be non-empty."
assert_contains "$malformed_sentry_trigger_output" "[android] Sentry trigger metadata line 8 in ${malformed_android_sentry_trigger_path} is malformed: key and value must both be non-empty."
assert_contains "$malformed_sentry_trigger_output" "completeness check FAILED with 10 issue(s)"
assert_not_contains "$malformed_sentry_trigger_output" "$android_credential_like_trigger_value"
assert_not_contains "$malformed_sentry_trigger_output" "$android_marker_like_trigger_value"
assert_not_contains "$malformed_sentry_trigger_output" "android-second-secret"

# Malformed Sentry source-map evidence must report the validation failure
# without exposing credential-like or marker-like values from the JSON.
malformed_sentry_evidence_root="$TEST_ROOT/malformed-sentry-evidence"
write_valid_run "$malformed_sentry_evidence_root" ios
write_valid_run "$malformed_sentry_evidence_root" android
credential_like_sentry_evidence_value='Bearer sentry-source-map-token-credential'
marker_like_sentry_evidence_value='sentry-source-map-marker-release-20260909'
cat > "$malformed_sentry_evidence_root/ios/20260909T120000Z/sentry-source-map-evidence.json" <<EOF
{
  "status": "PASS",
  "eventId": "0123456789abcdef0123456789abcdef",
  "platform": "ios",
  "candidateBuildId": "build-ios",
  "marker": "$marker_like_sentry_evidence_value",
  "release": "$credential_like_sentry_evidence_value",
  "dist": "42",
  "readableFrame": {
    "filename": "artifacts/chat-app/lib/sentry.ts",
    "function": "createNativeSourceMapProbeError",
    "line": 55,
    "column": 10
  }
EOF
if malformed_sentry_evidence_output="$(bash "$CHECKER" "$malformed_sentry_evidence_root" 2>&1)"; then
  echo "malformed Sentry source-map evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$malformed_sentry_evidence_output" "[ios] Invalid Sentry source-map evidence"
assert_contains "$malformed_sentry_evidence_output" "evidence contains credential-like content"
assert_contains "$malformed_sentry_evidence_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$malformed_sentry_evidence_output" "$credential_like_sentry_evidence_value"
assert_not_contains "$malformed_sentry_evidence_output" "$marker_like_sentry_evidence_value"

# Malformed Sentry source-map evidence that does not match credential-like
# preflight must report the stable parser-failure category without echoing the
# invalid value. The native parser's wording is intentionally not asserted:
# it can vary between supported Node releases.
parser_error_sentry_evidence_root="$TEST_ROOT/parser-error-sentry-evidence"
write_valid_run "$parser_error_sentry_evidence_root" ios
write_valid_run "$parser_error_sentry_evidence_root" android
parser_error_ios_marker='sentry-parser-marker-ios'
printf '%s\n' "$parser_error_ios_marker" \
  > "$parser_error_sentry_evidence_root/ios/20260909T120000Z/sentry-source-map-evidence.json"
parser_error_android_marker='sentry-parser-marker-android'
printf '%s\n' "$parser_error_android_marker" \
  > "$parser_error_sentry_evidence_root/android/20260909T120000Z/sentry-source-map-evidence.json"
if parser_error_sentry_evidence_output="$(bash "$CHECKER" "$parser_error_sentry_evidence_root" 2>&1)"; then
  echo "parser-error Sentry source-map evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$parser_error_sentry_evidence_output" "[ios] Invalid Sentry source-map evidence"
assert_contains "$parser_error_sentry_evidence_output" "evidence is not valid JSON"
assert_contains "$parser_error_sentry_evidence_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$parser_error_sentry_evidence_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$parser_error_sentry_evidence_output" "$parser_error_ios_marker"
assert_not_contains "$parser_error_sentry_evidence_output" "$parser_error_android_marker"

# A duplicate only silences the checks for that field; the remaining
# single-declaration fields are still validated by value.
partial_duplicate_root="$TEST_ROOT/partial-duplicate"
write_valid_run "$partial_duplicate_root" ios
write_valid_run "$partial_duplicate_root" android
cat > "$partial_duplicate_root/android/20260909T120000Z/pass-fail-record.txt" <<'EOF'
platform=android
run_mode=diagnostic-only
candidate_build_id=build-android
status=PASS
status=FAIL
native_screenshot_count=11
call_surface_screenshot_count=2
recorded_at_utc=2026-09-09T12:30:00Z
EOF
printf 'platform=android\r\n' >> "$partial_duplicate_root/ios/20260909T120000Z/runner-metadata.txt"
if partial_duplicate_output="$(bash "$CHECKER" "$partial_duplicate_root" 2>&1)"; then
  echo "partial duplicate metadata case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$partial_duplicate_output" "[android] Pass/fail record has 2 status declarations"
assert_contains "$partial_duplicate_output" "[android] The pass/fail record at $partial_duplicate_root/android/20260909T120000Z/pass-fail-record.txt is from a diagnostic-only run"
assert_contains "$partial_duplicate_output" "[ios] Runner metadata has 2 platform declarations"
assert_contains "$partial_duplicate_output" "completeness check FAILED with 3 issue(s)"
assert_not_contains "$partial_duplicate_output" "is not PASS"
assert_not_contains "$partial_duplicate_output" "status=FAIL"
assert_not_contains "$partial_duplicate_output" "Runner metadata identifies platform"
assert_not_contains "$partial_duplicate_output" "Runner metadata is missing"

# Conflicting completion times must not be compared against the review time:
# first-value parsing would accept a review that predates the later value.
duplicate_recorded_at_root="$TEST_ROOT/duplicate-recorded-at"
write_valid_run "$duplicate_recorded_at_root" ios
write_valid_run "$duplicate_recorded_at_root" android
write_review_record "$duplicate_recorded_at_root" ios APPROVED
write_review_record "$duplicate_recorded_at_root" android APPROVED "2026-09-09T13:00:00Z"
printf 'recorded_at_utc=2026-09-09T23:59:00Z\n' >> "$duplicate_recorded_at_root/android/20260909T120000Z/pass-fail-record.txt"
printf 'recorded_at_utc=2026-09-09T23:59:00Z\n' >> "$duplicate_recorded_at_root/android/20260909T120000Z/runner-metadata.txt"
if duplicate_recorded_at_output="$(bash "$CHECKER" "$duplicate_recorded_at_root" 2>&1)"; then
  echo "duplicate recorded_at_utc case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$duplicate_recorded_at_output" "[android] Pass/fail record has 2 recorded_at_utc declarations"
assert_contains "$duplicate_recorded_at_output" "[android] Runner metadata has 2 recorded_at_utc declarations"
assert_contains "$duplicate_recorded_at_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$duplicate_recorded_at_output" "predates the evidence"
assert_not_contains "$duplicate_recorded_at_output" "23:59:00Z"

field_text_in_notes_root="$TEST_ROOT/field-text-in-notes"
write_valid_run "$field_text_in_notes_root" ios
write_valid_run "$field_text_in_notes_root" android
write_review_record "$field_text_in_notes_root" ios APPROVED
cat > "$field_text_in_notes_root/android/20260909T120000Z/review-record.txt" <<'EOF'
platform=android
reviewer=Ada Reviewer
reviewed_at_utc=2026-09-09T13:00:00Z
candidate_build_id=build-android
decision=APPROVED
notes<<FINDINGS
decision=REJECTED
reviewer=This is literal note text, not a declaration.
FINDINGS
EOF
field_text_in_notes_output="$(bash "$CHECKER" "$field_text_in_notes_root" 2>&1)"
assert_contains "$field_text_in_notes_output" "[android] Review record: APPROVED for the validated candidate."
assert_contains "$field_text_in_notes_output" "passed for iOS and Android"

notes_before_fields_root="$TEST_ROOT/notes-before-fields"
write_valid_run "$notes_before_fields_root" ios
write_valid_run "$notes_before_fields_root" android
write_review_record "$notes_before_fields_root" ios APPROVED
cat > "$notes_before_fields_root/android/20260909T120000Z/review-record.txt" <<'EOF'
notes<<FINDINGS
decision=APPROVED
FINDINGS
platform=android
reviewer=Ada Reviewer
reviewed_at_utc=2026-09-09T13:00:00Z
candidate_build_id=build-android
decision=REJECTED
EOF
if notes_before_fields_output="$(bash "$CHECKER" "$notes_before_fields_root" 2>&1)"; then
  echo "notes-before-fields rejected review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$notes_before_fields_output" "[android] The review record at"
assert_contains "$notes_before_fields_output" "records a rejected decision."
assert_contains "$notes_before_fields_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$notes_before_fields_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$notes_before_fields_output" "[android] Review record: APPROVED"

unterminated_notes_root="$TEST_ROOT/unterminated-notes"
write_valid_run "$unterminated_notes_root" ios
write_valid_run "$unterminated_notes_root" android
write_review_record "$unterminated_notes_root" ios APPROVED
cat > "$unterminated_notes_root/android/20260909T120000Z/review-record.txt" <<'EOF'
platform=android
reviewer=Ada Reviewer
reviewed_at_utc=2026-09-09T13:00:00Z
candidate_build_id=build-android
decision=APPROVED
notes<<FINDINGS
- This block was not closed.
EOF
if unterminated_notes_output="$(bash "$CHECKER" "$unterminated_notes_root" 2>&1)"; then
  echo "unterminated notes block case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$unterminated_notes_output" "[android] Review record has an unterminated notes block"
assert_contains "$unterminated_notes_output" "Close it with the exact delimiter named after notes<<."
assert_contains "$unterminated_notes_output" "completeness check FAILED with 1 issue(s)"

mismatched_root="$TEST_ROOT/mismatched"
write_valid_run "$mismatched_root" ios
write_valid_run "$mismatched_root" android
write_review_record "$mismatched_root" ios APPROVED "2026-09-09T13:00:00Z" build-previous-candidate
write_review_record "$mismatched_root" android APPROVED "2026-09-09T12:10:00Z"
if mismatched_output="$(bash "$CHECKER" "$mismatched_root" 2>&1)"; then
  echo "mismatched review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$mismatched_output" "[ios] Review record candidate_build_id does not match the tested candidate in $mismatched_root/ios/20260909T120000Z/candidate-build-id.txt."
assert_contains "$mismatched_output" "[android] Review record reviewed_at_utc predates the evidence recorded_at_utc in $mismatched_root/android/20260909T120000Z."
assert_contains "$mismatched_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$mismatched_output" "build-previous-candidate"
assert_not_contains "$mismatched_output" "2026-09-09T12:10:00Z"

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
assert_contains "$malformed_output" "[ios] Review record reviewed_at_utc in $malformed_root/ios/20260909T120000Z/review-record.txt is not a UTC timestamp"
assert_contains "$malformed_output" "[ios] Review record contains an unsupported decision in $malformed_root/ios/20260909T120000Z/review-record.txt."
assert_contains "$malformed_output" "[android] Empty review record: $malformed_root/android/20260909T120000Z/review-record.txt"
assert_contains "$malformed_output" "completeness check FAILED with 4 issue(s)"
assert_not_contains "$malformed_output" "September 9"
assert_not_contains "$malformed_output" "MAYBE"

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
assert_contains "$wrong_platform_output" "[android] Review record identifies the wrong platform in $wrong_platform_root/android/20260909T120000Z/review-record.txt."

echo "Native large-text evidence completeness regression tests passed."