#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-native-large-text-evidence.sh"
SAVED_TEST_STATUS="$ROOT_DIR/artifacts/api-server/test-results/.last-run.json"
HOSTED_TAMPER_FIXTURES_ROOT="${NATIVE_EVIDENCE_TAMPER_FIXTURES_ROOT:-}"
PRIVACY_FAILURE_FIXTURE_ROOT="${NATIVE_EVIDENCE_PRIVACY_FAILURE_FIXTURE_ROOT:-}"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
SAVED_TEST_STATUS_SNAPSHOT="$TEST_PARENT/last-run.snapshot.json"
SAVED_TEST_STATUS_GUARDED=0
mkdir -p "$TEST_ROOT"
printf 'keep\n' > "$CLEANUP_GUARD"
# .last-run.json is gitignored Playwright output that only exists after the API
# browser suite has run locally, so a fresh clone or new git worktree has none.
# These tests never read it; the snapshot only proves that fixture cleanup left
# the developer's saved test status alone. Without the file there is nothing to
# protect, so say so explicitly instead of failing on the missing input.
if [[ -f "$SAVED_TEST_STATUS" ]]; then
  cp "$SAVED_TEST_STATUS" "$SAVED_TEST_STATUS_SNAPSHOT"
  SAVED_TEST_STATUS_GUARDED=1
else
  printf 'Skipping the saved API test status guard: %s is absent (gitignored Playwright output written by the API browser suite; these tests do not need it).\n' \
    "$SAVED_TEST_STATUS"
fi

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"

  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Native evidence test cleanup escaped its fixture directory" >&2
    return 1
  fi
  if ((SAVED_TEST_STATUS_GUARDED)) &&
    ! cmp -s "$SAVED_TEST_STATUS_SNAPSHOT" "$SAVED_TEST_STATUS"; then
    printf 'Native evidence test cleanup changed the saved API test status: %s no longer matches its pre-test snapshot (a concurrent API Playwright run rewrites this file too).\n' \
      "$SAVED_TEST_STATUS" >&2
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
  local run_timestamp="${7:-20260909T120000Z}"
  cat > "$root/$platform/$run_timestamp/review-record.txt" <<EOF
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
  local build_id="${3:-build-$platform}"
  local index

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"
  printf '%s\n' "$build_id" > "$run_dir/candidate-build-id.txt"
  # Mirror every field the native large-text runner writes, so duplicate-field
  # coverage tracks the real producer rather than a minimal subset.
  if [[ "$platform" == "ios" ]]; then
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=ios
run_mode=release-gate
candidate_build_id=$build_id
app_id=com.example.chat
device=iPhone SE (3rd generation)
device_udid=00000000-0000-0000-0000-000000000000
recorded_at_utc=2026-09-09T12:00:00Z
EOF
    printf '# iOS native readiness\n\n- Status: **READY**\n' > "$run_dir/ios-readiness.md"
  else
    cat > "$run_dir/runner-metadata.txt" <<EOF
platform=android
run_mode=release-gate
candidate_build_id=$build_id
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
    printf 'applicationLabel=Chat\npermissions=android.permission.INTERNET\n' > "$run_dir/android-badging.txt"
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
run_mode=release-gate
candidate_build_id=$build_id
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
candidate_build_id=$build_id
marker=run-1234-$platform
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{
  "status": "PASS",
  "eventId": "0123456789abcdef0123456789abcdef",
  "platform": "$platform",
  "candidateBuildId": "$build_id",
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

trusted_digest_manifest_for_run() {
  local run_dir="$1"
  (
    cd "$run_dir"
    find . -type f ! -name review-record.txt -print |
      LC_ALL=C sort |
      while IFS= read -r relative_path; do
        printf '%s  %s\n' \
          "$(sha256sum "$relative_path" | awk '{ print $1 }')" \
          "${relative_path#./}"
      done
  )
}

prepare_hosted_tamper_root() {
  local source_root="$1"
  local destination_root="$2"

  for platform in ios android; do
    if [[ ! -d "$source_root/$platform" ]]; then
      echo "Hosted tamper fixture is missing its $platform artifact directory" >&2
      exit 1
    fi
    cp -a "$source_root/$platform" "$destination_root/$platform"
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

blocked_summary_path="$TEST_ROOT/blocked-summary.md"
if GITHUB_STEP_SUMMARY="$blocked_summary_path" bash "$CHECKER" "$blocked_root" >/dev/null 2>&1; then
  echo "blocked summary case unexpectedly passed" >&2
  exit 1
fi
blocked_summary="$(cat "$blocked_summary_path")"
assert_contains "$blocked_summary" "## iOS native large-text evidence"
assert_contains "$blocked_summary" "## Android native large-text evidence"
assert_contains "$blocked_summary" "Only runner-check.txt is present in $blocked_root/ios"
assert_contains "$blocked_summary" "Only runner-check.txt is present in $blocked_root/android"

missing_ios_root="$TEST_ROOT/missing-ios"
write_valid_run "$missing_ios_root" android
missing_ios_summary_path="$TEST_ROOT/missing-ios-summary.md"
if missing_ios_output="$(
  GITHUB_STEP_SUMMARY="$missing_ios_summary_path" bash "$CHECKER" "$missing_ios_root" 2>&1
)"; then
  echo "missing iOS evidence case unexpectedly passed" >&2
  exit 1
fi
missing_ios_summary="$(cat "$missing_ios_summary_path")"
missing_ios_section="$(
  awk '
    /^## iOS native large-text evidence$/ { collecting=1 }
    /^## Android native large-text evidence$/ { collecting=0 }
    collecting { print }
  ' "$missing_ios_summary_path"
)"
missing_ios_android_section="$(
  awk '
    /^## Android native large-text evidence$/ { collecting=1 }
    collecting { print }
  ' "$missing_ios_summary_path"
)"
assert_contains "$missing_ios_output" "[ios] Missing result directory: $missing_ios_root/ios"
assert_contains "$missing_ios_output" "completeness check FAILED with 1 issue(s)"
assert_contains "$missing_ios_summary" "## iOS native large-text evidence"
assert_contains "$missing_ios_summary" "## Android native large-text evidence"
assert_contains "$missing_ios_section" "- Status: **FAIL**"
assert_contains "$missing_ios_section" "- Validated run directory: **Unavailable**"
assert_contains "$missing_ios_section" "- Detailed evidence report: **Unavailable**"
assert_contains "$missing_ios_section" "Missing result directory: $missing_ios_root/ios"
assert_not_contains "$missing_ios_section" "$missing_ios_root/android"
assert_contains "$missing_ios_android_section" "- Status: **PASS**"
assert_contains "$missing_ios_android_section" "- Validated run directory: \`$missing_ios_root/android/20260909T120000Z\`"
assert_not_contains "$missing_ios_android_section" "$missing_ios_root/ios"

missing_android_root="$TEST_ROOT/missing-android"
write_valid_run "$missing_android_root" ios
missing_android_summary_path="$TEST_ROOT/missing-android-summary.md"
if missing_android_output="$(
  GITHUB_STEP_SUMMARY="$missing_android_summary_path" bash "$CHECKER" "$missing_android_root" 2>&1
)"; then
  echo "missing Android evidence case unexpectedly passed" >&2
  exit 1
fi
missing_android_section="$(
  awk '
    /^## Android native large-text evidence$/ { collecting=1 }
    collecting { print }
  ' "$missing_android_summary_path"
)"
missing_android_ios_section="$(
  awk '
    /^## iOS native large-text evidence$/ { collecting=1 }
    /^## Android native large-text evidence$/ { collecting=0 }
    collecting { print }
  ' "$missing_android_summary_path"
)"
assert_contains "$missing_android_output" "[android] Missing result directory: $missing_android_root/android"
assert_contains "$missing_android_output" "completeness check FAILED with 1 issue(s)"
assert_contains "$missing_android_section" "- Status: **FAIL**"
assert_contains "$missing_android_section" "- Validated run directory: **Unavailable**"
assert_contains "$missing_android_section" "- Detailed evidence report: **Unavailable**"
assert_contains "$missing_android_section" "Missing result directory: $missing_android_root/android"
assert_not_contains "$missing_android_section" "$missing_android_root/ios"
assert_contains "$missing_android_ios_section" "- Status: **PASS**"
assert_contains "$missing_android_ios_section" "- Validated run directory: \`$missing_android_root/ios/20260909T120000Z\`"
assert_not_contains "$missing_android_ios_section" "$missing_android_root/android"

missing_both_root="$TEST_ROOT/missing-both"
mkdir -p "$missing_both_root"
missing_both_summary_path="$TEST_ROOT/missing-both-summary.md"
if missing_both_output="$(
  GITHUB_STEP_SUMMARY="$missing_both_summary_path" bash "$CHECKER" "$missing_both_root" 2>&1
)"; then
  echo "missing both platforms evidence case unexpectedly passed" >&2
  exit 1
fi
missing_both_summary="$(cat "$missing_both_summary_path")"
missing_both_ios_section="$(
  awk '
    /^## iOS native large-text evidence$/ { collecting=1 }
    /^## Android native large-text evidence$/ { collecting=0 }
    collecting { print }
  ' "$missing_both_summary_path"
)"
missing_both_android_section="$(
  awk '
    /^## Android native large-text evidence$/ { collecting=1 }
    collecting { print }
  ' "$missing_both_summary_path"
)"
assert_contains "$missing_both_output" "[ios] Missing result directory: $missing_both_root/ios"
assert_contains "$missing_both_output" "[android] Missing result directory: $missing_both_root/android"
assert_contains "$missing_both_output" "completeness check FAILED with 2 issue(s)"
assert_contains "$missing_both_summary" "## iOS native large-text evidence"
assert_contains "$missing_both_summary" "## Android native large-text evidence"
assert_contains "$missing_both_ios_section" "- Status: **FAIL**"
assert_contains "$missing_both_ios_section" "- Validated run directory: **Unavailable**"
assert_contains "$missing_both_ios_section" "- Detailed evidence report: **Unavailable**"
assert_contains "$missing_both_ios_section" "Missing result directory: $missing_both_root/ios"
assert_not_contains "$missing_both_ios_section" "$missing_both_root/android"
assert_contains "$missing_both_android_section" "- Status: **FAIL**"
assert_contains "$missing_both_android_section" "- Validated run directory: **Unavailable**"
assert_contains "$missing_both_android_section" "- Detailed evidence report: **Unavailable**"
assert_contains "$missing_both_android_section" "Missing result directory: $missing_both_root/android"
assert_not_contains "$missing_both_android_section" "$missing_both_root/ios"

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

conflicting_candidate_ids_root="$TEST_ROOT/conflicting-candidate-ids"
write_valid_run "$conflicting_candidate_ids_root" ios
write_valid_run "$conflicting_candidate_ids_root" android
conflicting_candidate_id_one="must-not-be-printed-conflicting-candidate-one"
conflicting_candidate_id_two="must-not-be-printed-conflicting-candidate-two"
printf '%s\n%s\n' \
  "$conflicting_candidate_id_one" \
  "$conflicting_candidate_id_two" \
  > "$conflicting_candidate_ids_root/android/20260909T120000Z/candidate-build-id.txt"
if conflicting_candidate_ids_output="$(bash "$CHECKER" "$conflicting_candidate_ids_root" 2>&1)"; then
  echo "conflicting candidate build IDs case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$conflicting_candidate_ids_output" "[android] Candidate build ID file at $conflicting_candidate_ids_root/android/20260909T120000Z/candidate-build-id.txt must contain exactly one non-empty identifier line."
assert_not_contains "$conflicting_candidate_ids_output" "$conflicting_candidate_id_one"
assert_not_contains "$conflicting_candidate_ids_output" "$conflicting_candidate_id_two"

duplicate_candidate_ids_root="$TEST_ROOT/duplicate-candidate-ids"
write_valid_run "$duplicate_candidate_ids_root" ios
write_valid_run "$duplicate_candidate_ids_root" android
duplicate_candidate_id="must-not-be-printed-duplicate-candidate"
printf '%s\n%s\n' \
  "$duplicate_candidate_id" \
  "$duplicate_candidate_id" \
  > "$duplicate_candidate_ids_root/android/20260909T120000Z/candidate-build-id.txt"
if duplicate_candidate_ids_output="$(bash "$CHECKER" "$duplicate_candidate_ids_root" 2>&1)"; then
  echo "duplicate candidate build IDs case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$duplicate_candidate_ids_output" "[android] Candidate build ID file at $duplicate_candidate_ids_root/android/20260909T120000Z/candidate-build-id.txt must contain exactly one non-empty identifier line."
assert_not_contains "$duplicate_candidate_ids_output" "$duplicate_candidate_id"

summary_root="$TEST_ROOT/summary"
write_valid_run "$summary_root" ios
write_valid_run "$summary_root" android
summary_path="$TEST_ROOT/summary.md"
GITHUB_STEP_SUMMARY="$summary_path" bash "$CHECKER" "$summary_root" >/dev/null 2>&1
summary="$(cat "$summary_path")"
assert_contains "$summary" "## iOS native large-text evidence"
assert_contains "$summary" "## Android native large-text evidence"
assert_contains "$summary" "- Status: **PASS**"
assert_contains "$summary" "- Validated run directory: \`$summary_root/ios/20260909T120000Z\`"
assert_contains "$summary" "- Validated run directory: \`$summary_root/android/20260909T120000Z\`"
assert_contains "$summary" "- Native screenshots: **11** (minimum 11; empty: 0)"
assert_contains "$summary" "- Call-surface screenshots: **2** (required 2; empty: 0)"
assert_contains "$summary" "### Review notices"
assert_contains "$summary" "Review record missing: $summary_root/ios/20260909T120000Z/review-record.txt"
assert_contains "$summary" "Review record missing: $summary_root/android/20260909T120000Z/review-record.txt"

summary_failure_root="$TEST_ROOT/summary-failure"
write_valid_run "$summary_failure_root" ios
write_valid_run "$summary_failure_root" android
rm "$summary_failure_root/android/20260909T120000Z/runner-metadata.txt"
: > "$summary_failure_root/ios/20260909T120000Z/call-surface/call-1.png"
rm "$summary_failure_root/ios/20260909T120000Z/screenshots/screen-11.png"
summary_failure_path="$TEST_ROOT/summary-failure.md"
if GITHUB_STEP_SUMMARY="$summary_failure_path" bash "$CHECKER" "$summary_failure_root" >/dev/null 2>&1; then
  echo "summary failure case unexpectedly passed" >&2
  exit 1
fi
ios_summary="$(
  awk '
    /^## iOS native large-text evidence$/ { collecting=1 }
    /^## Android native large-text evidence$/ { collecting=0 }
    collecting { print }
  ' "$summary_failure_path"
)"
android_summary="$(
  awk '
    /^## Android native large-text evidence$/ { collecting=1 }
    collecting { print }
  ' "$summary_failure_path"
)"
assert_contains "$ios_summary" "Expected at least 11 native screenshots"
assert_contains "$ios_summary" "Found 1 empty call-surface screenshot file(s)"
assert_not_contains "$ios_summary" "Missing runner metadata and device details"
assert_contains "$android_summary" "Missing runner metadata and device details"
assert_not_contains "$android_summary" "Expected at least 11 native screenshots"
assert_not_contains "$android_summary" "Found 1 empty call-surface screenshot file(s)"

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

oversized_root="$TEST_ROOT/oversized-evidence"
write_valid_run "$oversized_root" ios
write_valid_run "$oversized_root" android
oversized_sentinel="oversized-private-evidence-sentinel"
{
  printf '{"private":"%s","padding":"' "$oversized_sentinel"
  head -c 262144 /dev/zero | tr '\0' 'x'
  printf '"}\n'
} > "$oversized_root/android/20260909T120000Z/sentry-source-map-evidence.json"
if oversized_output="$(bash "$CHECKER" "$oversized_root" 2>&1)"; then
  echo "oversized Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$oversized_output" "[android] Invalid Sentry source-map evidence"
assert_contains "$oversized_output" "evidence exceeds the release evidence size limit"
assert_not_contains "$oversized_output" "$oversized_sentinel"

collection_size_root="$TEST_ROOT/collection-size"
write_valid_run "$collection_size_root" ios
write_valid_run "$collection_size_root" android
collection_size_sentinel="oversized-collection-private-sentinel"
printf '%s' "$collection_size_sentinel" > \
  "$collection_size_root/ios/20260909T120000Z/native-branding-check.md"
head -c 262145 /dev/zero | tr '\0' 'x' >> \
  "$collection_size_root/ios/20260909T120000Z/native-branding-check.md"
if collection_size_output="$(
  bash "$CHECKER" --check-collection-size \
    "$collection_size_root/ios/20260909T120000Z" 2>&1
)"; then
  echo "oversized collection text case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$collection_size_output" \
  "Native evidence text file exceeds the 256 KiB release evidence limit: native-branding-check.md."
assert_contains "$collection_size_output" \
  "no artifact will be uploaded"
assert_not_contains "$collection_size_output" "$collection_size_sentinel"
if ! bash "$CHECKER" --check-collection-size \
  "$collection_size_root/android/20260909T120000Z"; then
  echo "valid collection text case unexpectedly failed" >&2
  exit 1
fi

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
valid_ios_digest_manifest="$(trusted_digest_manifest_for_run "$valid_root/ios/20260909T120000Z")"
valid_android_digest_manifest="$(trusted_digest_manifest_for_run "$valid_root/android/20260909T120000Z")"
valid_output="$(bash "$CHECKER" "$valid_root" 2>&1)"
assert_contains "$valid_output" "passed for iOS and Android"
assert_contains "$valid_output" "[ios] Review record missing: $valid_root/ios/20260909T120000Z/review-record.txt does not exist"
assert_contains "$valid_output" "[android] Review record missing: $valid_root/android/20260909T120000Z/review-record.txt does not exist"
assert_contains "$valid_output" "Review pending for: ios android"
assert_contains "$valid_output" "complete review-record.template.txt and rename it to review-record.txt"
assert_not_contains "$valid_output" "Review record: APPROVED"

if strict_missing_output="$(
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 \
  NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST="$valid_ios_digest_manifest" \
  NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST="$valid_android_digest_manifest" \
  bash "$CHECKER" "$valid_root" 2>&1
)"; then
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
reviewed_ios_digest_manifest="$(trusted_digest_manifest_for_run "$reviewed_root/ios/20260909T120000Z")"
reviewed_android_digest_manifest="$(trusted_digest_manifest_for_run "$reviewed_root/android/20260909T120000Z")"
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
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 \
  NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST="$reviewed_ios_digest_manifest" \
  NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST="$reviewed_android_digest_manifest" \
  bash "$CHECKER" "$reviewed_root" 2>&1
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
candidate_scoped_ios_digest_manifest="$(trusted_digest_manifest_for_run "$candidate_scoped_root/ios/20260909T120000Z")"
candidate_scoped_android_digest_manifest="$(trusted_digest_manifest_for_run "$candidate_scoped_root/android/20260909T120000Z")"
write_review_record "$candidate_scoped_root" ios APPROVED "2026-09-09T13:00:00Z"
write_review_record "$candidate_scoped_root" android APPROVED "2026-09-09T13:00:00Z"
printf 'approval_scope=candidate\n' >> "$candidate_scoped_root/ios/20260909T120000Z/review-record.txt"
printf 'approval_scope=candidate\n' >> "$candidate_scoped_root/android/20260909T120000Z/review-record.txt"
mv "$candidate_scoped_root/ios/20260909T120000Z" "$candidate_scoped_root/ios/20260910T120000Z"
mv "$candidate_scoped_root/android/20260909T120000Z" "$candidate_scoped_root/android/20260910T120000Z"
candidate_scoped_output="$(
  NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 \
  NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST="$candidate_scoped_ios_digest_manifest" \
  NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST="$candidate_scoped_android_digest_manifest" \
  bash "$CHECKER" "$candidate_scoped_root" 2>&1
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

# Blank lines immediately before the closing delimiter are valid note content,
# not an unterminated block. Bash command substitution strips trailing
# newlines when the checker captures notes, so this coverage is specifically
# about the delimiter-adjacent boundary rather than internal blank lines
# (already covered above).
trailing_blank_notes_root="$TEST_ROOT/trailing-blank-notes"
write_valid_run "$trailing_blank_notes_root" ios
write_valid_run "$trailing_blank_notes_root" android
write_review_record "$trailing_blank_notes_root" ios APPROVED
printf '%s\n' \
  'platform=android' \
  'reviewer=Ada Reviewer' \
  'reviewed_at_utc=2026-09-09T13:00:00Z' \
  'candidate_build_id=build-android' \
  'decision=REJECTED' \
  'notes<<END_NOTES' \
  '- The `Send` button overlaps the final line.' \
  '' \
  '' \
  'END_NOTES' \
  > "$trailing_blank_notes_root/android/20260909T120000Z/review-record.txt"
if trailing_blank_notes_output="$(bash "$CHECKER" "$trailing_blank_notes_root" 2>&1)"; then
  echo "trailing blank notes rejected review case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$trailing_blank_notes_output" "[android] The review record at $trailing_blank_notes_root/android/20260909T120000Z/review-record.txt records a rejected decision."
assert_contains "$trailing_blank_notes_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$trailing_blank_notes_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$trailing_blank_notes_output" "unterminated notes block"
assert_not_contains "$trailing_blank_notes_output" "The \`Send\` button overlaps"

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
privacy_rejected_summary_path="$TEST_ROOT/privacy-rejected-summary.md"
if privacy_rejected_output="$(
  GITHUB_STEP_SUMMARY="$privacy_rejected_summary_path" bash "$CHECKER" "$privacy_rejected_root" 2>&1
)"; then
  echo "private rejected review case unexpectedly passed" >&2
  exit 1
fi
privacy_rejected_summary="$(cat "$privacy_rejected_summary_path")"
assert_contains "$privacy_rejected_output" "[android] The review record at $privacy_rejected_root/android/20260909T120000Z/review-record.txt records a rejected decision."
assert_contains "$privacy_rejected_output" "[android] Review notes were supplied but are omitted from automated release output."
assert_contains "$privacy_rejected_output" "completeness check FAILED with 1 issue(s)"
assert_not_contains "$privacy_rejected_output" "$review_note_credential"
assert_not_contains "$privacy_rejected_output" "$review_note_marker"
assert_contains "$privacy_rejected_summary" "## Android native large-text evidence"
assert_contains "$privacy_rejected_summary" "- Status: **FAIL**"
assert_contains "$privacy_rejected_summary" "Review notes were supplied but are omitted from automated release output."
assert_not_contains "$privacy_rejected_summary" "$review_note_credential"
assert_not_contains "$privacy_rejected_summary" "$review_note_marker"

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
# duplicated with a conflicting value on both platforms. Each duplicate must
# be reported without selecting, comparing, or printing either value.
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
  runner_duplicate_count="$(metadata_keys_of "$runner_metadata_path" | sort -u | wc -l)"
  for _ in $(seq 1 "$runner_duplicate_count"); do
    assert_contains "$duplicate_machine_metadata_output" "[$platform] Runner metadata contains a duplicate field (2 declarations) in ${runner_metadata_path}."
    assert_contains "$duplicate_machine_metadata_output" "Keep each runner metadata field to one declaration"
  done
  pass_fail_path="$duplicate_machine_metadata_root/$platform/20260909T120000Z/pass-fail-record.txt"
  pass_fail_duplicate_count="$(metadata_keys_of "$pass_fail_path" | sort -u | wc -l)"
  for _ in $(seq 1 "$pass_fail_duplicate_count"); do
    assert_contains "$duplicate_machine_metadata_output" "[$platform] Pass/fail record contains a duplicate field (2 declarations) in ${pass_fail_path}."
    assert_contains "$duplicate_machine_metadata_output" "Keep each pass/fail record field to one declaration"
  done
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
  sentry_duplicate_count="$(metadata_keys_of "$sentry_trigger_path" | sort -u | wc -l)"
  for _ in $(seq 1 "$sentry_duplicate_count"); do
    assert_contains "$duplicate_sentry_trigger_output" "[$platform] Sentry trigger metadata contains a duplicate field (2 declarations) in ${sentry_trigger_path}."
    assert_contains "$duplicate_sentry_trigger_output" "Keep each Sentry trigger metadata field to one declaration"
  done
done
assert_contains "$duplicate_sentry_trigger_output" "completeness check FAILED with ${expected_sentry_trigger_issues} issue(s)"
assert_not_contains "$duplicate_sentry_trigger_output" "must-not-be-printed"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger platform does not match"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger candidate build ID does not match"
assert_not_contains "$duplicate_sentry_trigger_output" "trigger marker does not match"

# Conflicting Sentry evidence fields, including fields nested in the readable
# frame object, must be rejected before JSON.parse can select the later
# declaration, without exposing either field value.
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
evidence = evidence.replace(
  /(\n    "filename": "[^"]+",)/,
  `$1\n    "filename": "must-not-be-printed-nested-filename",`,
);
writeFileSync(path, evidence);
NODE
done
if duplicate_sentry_evidence_output="$(bash "$CHECKER" "$duplicate_sentry_evidence_root" 2>&1)"; then
  echo "duplicate Sentry source-map evidence case unexpectedly passed" >&2
  exit 1
fi
for platform in ios android; do
  assert_contains "$duplicate_sentry_evidence_output" "[$platform] Invalid Sentry source-map evidence"
  assert_contains "$duplicate_sentry_evidence_output" "duplicate JSON field(s)"
done
assert_contains "$duplicate_sentry_evidence_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$duplicate_sentry_evidence_output" "must-not-be-printed"

# Duplicate JSON keys with an attacker-controlled field name must report only
# the fixed structural failure category.
malicious_duplicate_sentry_evidence_root="$TEST_ROOT/malicious-duplicate-sentry-evidence"
write_valid_run "$malicious_duplicate_sentry_evidence_root" ios
write_valid_run "$malicious_duplicate_sentry_evidence_root" android
malicious_json_field='sentry-duplicate-secret-sentinel'
for platform in ios android; do
  sentry_evidence_path="$malicious_duplicate_sentry_evidence_root/$platform/20260909T120000Z/sentry-source-map-evidence.json"
  node --input-type=module - "$sentry_evidence_path" "$malicious_json_field" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const field = process.argv[3];
let evidence = readFileSync(path, "utf8");
evidence = evidence.replace(
  /\n  "dist": "42",/,
  `\n  "${field}": "first",\n  "${field}": "second",\n  "dist": "42",`,
);
writeFileSync(path, evidence);
NODE
done
if malicious_duplicate_sentry_evidence_output="$(
  bash "$CHECKER" "$malicious_duplicate_sentry_evidence_root" 2>&1
)"; then
  echo "malicious duplicate Sentry evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$malicious_duplicate_sentry_evidence_output" "duplicate JSON field(s)"
assert_contains "$malicious_duplicate_sentry_evidence_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$malicious_duplicate_sentry_evidence_output" "$malicious_json_field"

# Unsafe downloaded run-directory names must be rejected before their names
# can reach logs or the step summary.
unsafe_run_root="$TEST_ROOT/unsafe-run-directory"
mkdir -p "$unsafe_run_root/ios" "$unsafe_run_root/android"
unsafe_run_name=$'20260909T120000Z`forged-heading\nforged-summary-line'
mkdir -p "$unsafe_run_root/ios/$unsafe_run_name"
printf 'Result: BLOCKED\n' > "$unsafe_run_root/ios/$unsafe_run_name/runner-check.txt"
write_valid_run "$unsafe_run_root" android
unsafe_summary_path="$TEST_ROOT/unsafe-run-directory.md"
if unsafe_run_output="$(
  GITHUB_STEP_SUMMARY="$unsafe_summary_path" bash "$CHECKER" "$unsafe_run_root" 2>&1
)"; then
  echo "unsafe run-directory case unexpectedly passed" >&2
  exit 1
fi
unsafe_summary="$(cat "$unsafe_summary_path")"
assert_contains "$unsafe_run_output" "Evidence run directory name"
assert_contains "$unsafe_run_output" "is unsafe"
assert_contains "$unsafe_summary" "## iOS native large-text evidence"
assert_not_contains "$unsafe_run_output" "$unsafe_run_name"
assert_not_contains "$unsafe_summary" "$unsafe_run_name"
assert_not_contains "$unsafe_summary" "forged-summary-line"

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

# Malformed JUnit/XML evidence must report only the fixed structural reason;
# the checker does not parse XML, so a marker in the malformed body must not
# become part of its diagnostic.
parser_error_junit_root="$TEST_ROOT/parser-error-junit"
write_valid_run "$parser_error_junit_root" ios
write_valid_run "$parser_error_junit_root" android
parser_error_maestro_marker='maestro-parser-marker-private'
parser_error_sentry_maestro_marker='sentry-maestro-parser-marker-private'
printf '<junit><failure>%s</failure></junit>\n' "$parser_error_maestro_marker" \
  > "$parser_error_junit_root/ios/20260909T120000Z/maestro-results.xml"
printf '<junit><failure>%s</failure></junit>\n' "$parser_error_sentry_maestro_marker" \
  > "$parser_error_junit_root/android/20260909T120000Z/sentry-maestro-results.xml"
if parser_error_junit_output="$(bash "$CHECKER" "$parser_error_junit_root" 2>&1)"; then
  echo "parser-error JUnit evidence case unexpectedly passed" >&2
  exit 1
fi
assert_contains "$parser_error_junit_output" \
  "The JUnit result at $parser_error_junit_root/ios/20260909T120000Z/maestro-results.xml is not a recognizable testsuite report."
assert_contains "$parser_error_junit_output" \
  "The controlled Sentry probe JUnit result at $parser_error_junit_root/android/20260909T120000Z/sentry-maestro-results.xml is not a recognizable testsuite report."
assert_not_contains "$parser_error_junit_output" "$parser_error_maestro_marker"
assert_not_contains "$parser_error_junit_output" "$parser_error_sentry_maestro_marker"

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
assert_contains "$partial_duplicate_output" "[android] Pass/fail record contains a duplicate field (2 declarations)"
assert_contains "$partial_duplicate_output" "[android] The pass/fail record at $partial_duplicate_root/android/20260909T120000Z/pass-fail-record.txt is from a diagnostic-only run"
assert_contains "$partial_duplicate_output" "[ios] Runner metadata contains a duplicate field (2 declarations)"
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
assert_contains "$duplicate_recorded_at_output" "[android] Pass/fail record contains a duplicate field (2 declarations)"
assert_contains "$duplicate_recorded_at_output" "[android] Runner metadata contains a duplicate field (2 declarations)"
assert_contains "$duplicate_recorded_at_output" "completeness check FAILED with 2 issue(s)"
assert_not_contains "$duplicate_recorded_at_output" "predates the evidence"
assert_not_contains "$duplicate_recorded_at_output" "23:59:00Z"

# Duplicate metadata field names are untrusted input. Newline, tab, and
# terminal-control bytes must not be able to inject lines, columns, or terminal
# effects into the release diagnostic.
malicious_duplicate_field_root="$TEST_ROOT/malicious-duplicate-field"
write_valid_run "$malicious_duplicate_field_root" ios
write_valid_run "$malicious_duplicate_field_root" android
write_review_record "$malicious_duplicate_field_root" ios APPROVED
write_review_record "$malicious_duplicate_field_root" android APPROVED
malicious_duplicate_metadata_path="$malicious_duplicate_field_root/android/20260909T120000Z/pass-fail-record.txt"
malicious_duplicate_field_summary_path="$TEST_ROOT/malicious-duplicate-field-summary.md"
newline_field_name=$'native-newline-field\nforged-log-line'
tab_field_name=$'native-tab-field\tforged-log-column'
terminal_control_field_name=$'native-terminal-field\033[31m'
{
  printf '%s=first\n%s=second\n' "$newline_field_name" "$newline_field_name"
  printf '%s=first\n%s=second\n' "$tab_field_name" "$tab_field_name"
  printf '%s=first\n%s=second\n' "$terminal_control_field_name" "$terminal_control_field_name"
} >> "$malicious_duplicate_metadata_path"
if malicious_duplicate_field_output="$(
  GITHUB_STEP_SUMMARY="$malicious_duplicate_field_summary_path" \
    bash "$CHECKER" "$malicious_duplicate_field_root" 2>&1
)"; then
  echo "malicious duplicate field name case unexpectedly passed" >&2
  exit 1
fi
malicious_duplicate_field_summary="$(cat "$malicious_duplicate_field_summary_path")"
assert_contains "$malicious_duplicate_field_output" "[android] Pass/fail record contains a duplicate field (2 declarations)"
assert_contains "$malicious_duplicate_field_output" "completeness check FAILED with 3 issue(s)"
assert_contains "$malicious_duplicate_field_summary" "Pass/fail record contains a duplicate field (2 declarations)"
assert_not_contains "$malicious_duplicate_field_output" "$newline_field_name"
assert_not_contains "$malicious_duplicate_field_output" "$tab_field_name"
assert_not_contains "$malicious_duplicate_field_output" "$terminal_control_field_name"
assert_not_contains "$malicious_duplicate_field_output" "native-newline-field"
assert_not_contains "$malicious_duplicate_field_output" "native-tab-field"
assert_not_contains "$malicious_duplicate_field_output" "native-terminal-field"
assert_not_contains "$malicious_duplicate_field_summary" "$newline_field_name"
assert_not_contains "$malicious_duplicate_field_summary" "$tab_field_name"
assert_not_contains "$malicious_duplicate_field_summary" "$terminal_control_field_name"
assert_not_contains "$malicious_duplicate_field_summary" "native-newline-field"
assert_not_contains "$malicious_duplicate_field_summary" "native-tab-field"
assert_not_contains "$malicious_duplicate_field_summary" "native-terminal-field"

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

# A downloaded evidence artifact can be changed after the candidate approval is
# recorded. The strict publish validation must block the submission boundary for
# either platform, record a fixed blocked result, and keep candidate/reviewer
# values out of its diagnostics and summary.
for tampered_platform in ios android; do
  tampered_root="$TEST_ROOT/tampered-$tampered_platform"
  tampered_summary_path="$TEST_ROOT/tampered-$tampered_platform-summary.md"
  submission_marker="$tampered_root/submission-command-ran"
  blocked_result="$tampered_root/store-submission-result.txt"
  private_candidate_id="candidate-$tampered_platform-private-sentinel"
  private_reviewer="reviewer-$tampered_platform-private-sentinel"

  if [[ -n "$HOSTED_TAMPER_FIXTURES_ROOT" ]]; then
    mkdir -p "$tampered_root"
    prepare_hosted_tamper_root "$HOSTED_TAMPER_FIXTURES_ROOT" "$tampered_root"
    for fixture_platform in ios android; do
      fixture_run_dir="$tampered_root/$fixture_platform/20260915T120000Z"
      if [[ ! -d "$fixture_run_dir" ]]; then
        echo "Hosted tamper fixture has an unexpected $fixture_platform run layout" >&2
        exit 1
      fi
      printf '%s\n' "$private_candidate_id" > "$fixture_run_dir/candidate-build-id.txt"
      sed -i "s/^candidate_build_id=.*/candidate_build_id=$private_candidate_id/" \
        "$fixture_run_dir/runner-metadata.txt" \
        "$fixture_run_dir/pass-fail-record.txt" \
        "$fixture_run_dir/sentry-trigger.txt" \
        "$fixture_run_dir/sentry-source-map-evidence.json"
      write_review_record \
        "$tampered_root" \
        "$fixture_platform" \
        APPROVED \
        "2026-09-15T12:01:00Z" \
        "$private_candidate_id" \
        "$private_reviewer" \
        "20260915T120000Z"
    done
  else
    write_valid_run "$tampered_root" ios "$private_candidate_id"
    write_valid_run "$tampered_root" android "$private_candidate_id"
    write_review_record \
      "$tampered_root" \
      ios \
      APPROVED \
      "2026-09-09T13:00:00Z" \
      "$private_candidate_id" \
      "$private_reviewer"
    write_review_record \
      "$tampered_root" \
      android \
      APPROVED \
      "2026-09-09T13:00:00Z" \
      "$private_candidate_id" \
      "$private_reviewer"
  fi

  tampered_run_timestamp="$([[ -n "$HOSTED_TAMPER_FIXTURES_ROOT" ]] && printf '20260915T120000Z' || printf '20260909T120000Z')"
  ios_digest_manifest="$(trusted_digest_manifest_for_run "$tampered_root/ios/$tampered_run_timestamp")"
  android_digest_manifest="$(trusted_digest_manifest_for_run "$tampered_root/android/$tampered_run_timestamp")"
  tampered_run_dir="$tampered_root/$tampered_platform/$tampered_run_timestamp"
  if [[ -n "$HOSTED_TAMPER_FIXTURES_ROOT" ]]; then
    sed -i 's/^status=.*/status=FAIL/' "$tampered_run_dir/pass-fail-record.txt"
  else
    cat > "$tampered_run_dir/pass-fail-record.txt" <<EOF
platform=$tampered_platform
run_mode=release-gate
candidate_build_id=$private_candidate_id
status=FAIL
native_screenshot_count=11
call_surface_screenshot_count=2
recorded_at_utc=2026-09-09T12:30:00Z
EOF
  fi

  fake_store_submission() {
    printf 'submitted\n' > "$submission_marker"
  }

  if validation_output="$(
    GITHUB_STEP_SUMMARY="$tampered_summary_path" \
      NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 \
      NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST="$ios_digest_manifest" \
      NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST="$android_digest_manifest" \
      bash "$CHECKER" "$tampered_root" 2>&1
  )"; then
    fake_store_submission
    echo "tampered $tampered_platform evidence unexpectedly passed strict validation" >&2
    exit 1
  else
    printf 'status=BLOCKED\nreason=native-evidence-validation-failed\n' > "$blocked_result"
  fi

  if [[ -e "$submission_marker" ]]; then
    echo "tampered $tampered_platform evidence reached the store submission command" >&2
    exit 1
  fi
  assert_contains "$validation_output" "[$tampered_platform] The pass/fail record at"
  assert_contains "$validation_output" "is not PASS."
  assert_contains "$(cat "$blocked_result")" "status=BLOCKED"
  assert_contains "$(cat "$blocked_result")" "reason=native-evidence-validation-failed"
  assert_contains "$(cat "$tampered_summary_path")" "- Status: **FAIL**"
  assert_not_contains "$validation_output" "$private_candidate_id"
  assert_not_contains "$validation_output" "$private_reviewer"
  assert_not_contains "$(cat "$tampered_summary_path")" "$private_candidate_id"
  assert_not_contains "$(cat "$tampered_summary_path")" "$private_reviewer"
  if [[ -n "$HOSTED_TAMPER_FIXTURES_ROOT" ]]; then
    echo "Hosted tampered $tampered_platform evidence recorded BLOCKED without invoking the submission stub."
  fi
done

# Screenshot files and Sentry evidence are downloaded separately from the
# pass/fail record. Mutating either input after approval must still block the
# publish boundary even when the mutation remains non-empty and structurally
# valid, without copying private evidence, candidate, or reviewer values into
# diagnostics or the step summary.
for artifact_mutation in ios-screenshot android-sentry; do
  if [[ "$artifact_mutation" == "ios-screenshot" ]]; then
    tampered_platform=ios
  else
    tampered_platform=android
  fi

  tampered_root="$TEST_ROOT/tampered-$artifact_mutation"
  tampered_summary_path="$TEST_ROOT/tampered-$artifact_mutation-summary.md"
  submission_marker="$tampered_root/submission-command-ran"
  blocked_result="$tampered_root/store-submission-result.txt"
  private_candidate_id="candidate-$artifact_mutation-private-sentinel"
  private_reviewer="reviewer-$artifact_mutation-private-sentinel"
  private_evidence="evidence-$artifact_mutation-private-sentinel"

  write_valid_run "$tampered_root" ios "$private_candidate_id"
  write_valid_run "$tampered_root" android "$private_candidate_id"
  write_review_record \
    "$tampered_root" \
    ios \
    APPROVED \
    "2026-09-09T13:00:00Z" \
    "$private_candidate_id" \
    "$private_reviewer"
  write_review_record \
    "$tampered_root" \
    android \
    APPROVED \
    "2026-09-09T13:00:00Z" \
    "$private_candidate_id" \
    "$private_reviewer"

  ios_digest_manifest="$(trusted_digest_manifest_for_run "$tampered_root/ios/20260909T120000Z")"
  android_digest_manifest="$(trusted_digest_manifest_for_run "$tampered_root/android/20260909T120000Z")"
  tampered_run_dir="$tampered_root/$tampered_platform/20260909T120000Z"
  if [[ "$artifact_mutation" == "ios-screenshot" ]]; then
    printf '%s\n' "$private_evidence" \
      > "$tampered_run_dir/screenshots/screen-11.png"
  else
    sed -i \
      "s/\"release\": \"chat-app@1.0.0+abc123\"/\"release\": \"$private_evidence\"/" \
      "$tampered_run_dir/sentry-source-map-evidence.json"
  fi

  fake_store_submission() {
    printf 'submitted\n' > "$submission_marker"
  }

  if validation_output="$(
    GITHUB_STEP_SUMMARY="$tampered_summary_path" \
      NATIVE_EVIDENCE_REQUIRE_APPROVAL=1 \
      NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST="$ios_digest_manifest" \
      NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST="$android_digest_manifest" \
      bash "$CHECKER" "$tampered_root" 2>&1
  )"; then
    fake_store_submission
    echo "tampered $artifact_mutation evidence unexpectedly passed strict validation" >&2
    exit 1
  else
    printf 'status=BLOCKED\nreason=native-evidence-validation-failed\n' > "$blocked_result"
  fi

  if [[ -e "$submission_marker" ]]; then
    echo "tampered $artifact_mutation evidence reached the store submission command" >&2
    exit 1
  fi
  assert_contains "$validation_output" "[$tampered_platform]"
  if [[ "$artifact_mutation" == "ios-screenshot" ]]; then
    assert_contains "$validation_output" "does not match the trusted digest manifest"
  else
    assert_contains "$validation_output" "does not match the trusted digest manifest"
  fi
  assert_contains "$(cat "$blocked_result")" "status=BLOCKED"
  assert_contains "$(cat "$blocked_result")" "reason=native-evidence-validation-failed"
  assert_contains "$(cat "$tampered_summary_path")" "- Status: **FAIL**"
  assert_not_contains "$validation_output" "$private_candidate_id"
  assert_not_contains "$validation_output" "$private_reviewer"
  assert_not_contains "$validation_output" "$private_evidence"
  assert_not_contains "$(cat "$tampered_summary_path")" "$private_candidate_id"
  assert_not_contains "$(cat "$tampered_summary_path")" "$private_reviewer"
  assert_not_contains "$(cat "$tampered_summary_path")" "$private_evidence"
done

# Exercise the publish summary branch after a controlled privacy failure. The
# checker summary and the reviewer-visible publish summary must remain safe even
# when the failed fixture directory contains private content.
privacy_root="$TEST_ROOT/privacy-publish-boundary"
privacy_checker_summary="$TEST_ROOT/privacy-checker-summary.md"
privacy_publish_summary="$TEST_ROOT/privacy-publish-summary.md"
privacy_submission_marker="$privacy_root/store-submission-command-ran"
privacy_fixture_sentinel="privacy-fixture-contents-must-not-appear"
mkdir -p "$privacy_root"
printf '%s\n' "$privacy_fixture_sentinel" > "$privacy_root/private-fixture-content.txt"

privacy_checker_status=0
if privacy_checker_output="$(
  GITHUB_STEP_SUMMARY="$privacy_checker_summary" \
    bash "$ROOT_DIR/scripts/run-untrusted-checker.sh" \
    bash "$CHECKER" "$privacy_root" 2>&1
)"; then
  privacy_checker_status=0
else
  privacy_checker_status=$?
fi
if [[ "$privacy_checker_status" == "0" ]]; then
  echo "controlled failed privacy scenario unexpectedly passed" >&2
  exit 1
fi

privacy_result=failure
{
  echo "## Native evidence privacy and submission-boundary regression"
  echo
  if [[ "$privacy_result" == "success" ]]; then
    echo "- Status: **PASS**"
    echo "- Result: privacy and submission-boundary checks passed."
  else
    echo "- Status: **BLOCKED**"
    echo "- Result: privacy checks failed; store submission is blocked."
    echo '- Details: Review the "Run native large-text evidence privacy and submission-boundary regression" step log for checker diagnostics.'
  fi
} > "$privacy_publish_summary"

simulate_privacy_store_submission() {
  printf 'submission-reached\n' > "$privacy_submission_marker"
}
if [[ "$privacy_result" == "success" ]]; then
  simulate_privacy_store_submission
fi

assert_contains "$(cat "$privacy_publish_summary")" "- Status: **BLOCKED**"
assert_contains "$(cat "$privacy_publish_summary")" \
  "privacy checks failed; store submission is blocked."
if [[ -e "$privacy_submission_marker" ]]; then
  echo "failed privacy scenario reached the simulated store submission boundary" >&2
  exit 1
fi
assert_not_contains "$privacy_checker_output" "$privacy_fixture_sentinel"
assert_not_contains "$(cat "$privacy_checker_summary")" "$privacy_fixture_sentinel"
assert_not_contains "$(cat "$privacy_publish_summary")" "$privacy_fixture_sentinel"

if [[ -n "$PRIVACY_FAILURE_FIXTURE_ROOT" ]]; then
  # Hosted release validation opts into one controlled failure of this real
  # privacy command. The fault injection is explicit and inert for normal
  # local and release runs.
  privacy_failure_root="$PRIVACY_FAILURE_FIXTURE_ROOT"
  privacy_failure_summary="$privacy_failure_root/privacy-checker-summary.md"
  privacy_failure_sentinel="privacy-fixture-contents-must-not-appear"
  rm -rf -- "$privacy_failure_root"
  mkdir -p -- "$privacy_failure_root"
  write_valid_run "$privacy_failure_root" ios "privacy-private-candidate"
  write_valid_run "$privacy_failure_root" android "privacy-private-candidate"
  write_review_record \
    "$privacy_failure_root" \
    ios \
    APPROVED \
    "2026-09-15T13:00:00Z" \
    "privacy-private-candidate" \
    "privacy-private-reviewer"
  write_review_record \
    "$privacy_failure_root" \
    android \
    APPROVED \
    "2026-09-15T13:00:00Z" \
    "privacy-private-candidate" \
    "privacy-private-reviewer"
  printf '%s\n' "$privacy_failure_sentinel" \
    > "$privacy_failure_root/private-fixture-content.txt"
  rm "$privacy_failure_root/ios/20260909T120000Z/runner-metadata.txt"

  if privacy_failure_output="$(
    GITHUB_STEP_SUMMARY="$privacy_failure_summary" \
      bash "$CHECKER" "$privacy_failure_root" 2>&1
  )"; then
    echo "controlled failed privacy fixture unexpectedly passed" >&2
    exit 1
  fi
  assert_contains "$privacy_failure_output" "[ios] Missing runner metadata and device details"
  assert_contains "$(cat "$privacy_failure_summary")" "- Status: **FAIL**"
  assert_not_contains "$privacy_failure_output" "$privacy_failure_sentinel"
  assert_not_contains "$(cat "$privacy_failure_summary")" "$privacy_failure_sentinel"
  echo "Controlled native privacy failure fixture was rejected without exposing its contents."
  exit 1
fi

cleanup_test_fixtures
trap - EXIT

echo "Native large-text evidence completeness regression tests passed."
