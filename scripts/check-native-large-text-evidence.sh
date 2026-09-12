#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${1:-$ROOT_DIR/test-results/native-large-text}"
FAILURE_COUNT=0
REVIEW_PENDING_PLATFORMS=()
REVIEW_DECISIONS=()
REQUIRE_APPROVAL="${NATIVE_EVIDENCE_REQUIRE_APPROVAL:-0}"
UTC_TIMESTAMP_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
TEMPLATE_PLACEHOLDER_PATTERN='^<.*>$'

if [[ "$REQUIRE_APPROVAL" != "0" && "$REQUIRE_APPROVAL" != "1" ]]; then
  echo "NATIVE_EVIDENCE_REQUIRE_APPROVAL must be 0 or 1." >&2
  exit 2
fi

issue() {
  local platform="$1"
  shift
  printf '[%s] %s\n' "$platform" "$*" >&2
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
}

notice() {
  local platform="$1"
  shift
  printf '[%s] %s\n' "$platform" "$*" >&2
}

metadata_value() {
  local metadata_path="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$metadata_path" | head -n 1
}

# Hand-written review records may carry Windows line endings or stray spaces.
trimmed_value() {
  local metadata_path="$1"
  local key="$2"
  metadata_value "$metadata_path" "$key" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

first_line_trimmed() {
  head -n 1 "$1" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

check_required_file() {
  local platform="$1"
  local run_dir="$2"
  local relative_path="$3"
  local description="$4"
  local path="$run_dir/$relative_path"

  if [[ ! -e "$path" ]]; then
    issue "$platform" "Missing ${description}: ${path}. Re-run the native large-text gate on the prepared device and upload the complete result directory."
  elif [[ ! -s "$path" ]]; then
    issue "$platform" "Empty ${description}: ${path}. Replace the incomplete artifact with output from a completed native large-text run."
  fi
}

validate_platform() {
  local platform="$1"
  local platform_dir="$RESULTS_ROOT/$platform"
  local run_dirs=()
  local run_dir

  if [[ ! -d "$platform_dir" ]]; then
    issue "$platform" "Missing result directory: ${platform_dir}. Run the ${platform} native large-text gate and upload its timestamped result directory."
    return
  fi

  mapfile -t run_dirs < <(find "$platform_dir" -mindepth 1 -maxdepth 1 -type d -print | sort)
  if ((${#run_dirs[@]} == 0)); then
    if [[ -s "$platform_dir/runner-check.txt" ]]; then
      issue "$platform" "Only runner-check.txt is present in ${platform_dir}. It is blocked runner diagnostics, not reviewed device evidence; do not record a review decision for it. Run on a prepared ${platform} runner and upload the timestamped result directory."
    else
      issue "$platform" "No timestamped evidence run directory exists in ${platform_dir}. Run the ${platform} native large-text gate and upload its complete result directory."
    fi
    return
  fi

  if ((${#run_dirs[@]} > 1)); then
    issue "$platform" "Found ${#run_dirs[@]} timestamped evidence directories in ${platform_dir}; keep only the result for this release review so stale or incomplete evidence cannot be selected."
    return
  fi
  run_dir="${run_dirs[0]}"

  check_required_file "$platform" "$run_dir" "candidate-build-id.txt" "candidate build ID"
  check_required_file "$platform" "$run_dir" "runner-metadata.txt" "runner metadata and device details"
  check_required_file "$platform" "$run_dir" "pass-fail-record.txt" "pass/fail record"
  check_required_file "$platform" "$run_dir" "native-info.json" "compiled native metadata"
  check_required_file "$platform" "$run_dir" "native-branding-check.md" "native branding report"
  check_required_file "$platform" "$run_dir" "maestro-results.xml" "JUnit result"
  check_required_file "$platform" "$run_dir" "sentry-maestro-results.xml" "controlled Sentry probe JUnit result"
  check_required_file "$platform" "$run_dir" "sentry-trigger.txt" "controlled Sentry probe metadata"
  check_required_file "$platform" "$run_dir" "sentry-source-map-evidence.json" "Sentry source-map evidence"

  if [[ -s "$run_dir/pass-fail-record.txt" ]] &&
    ! grep -Eq '^status=PASS[[:space:]]*$' "$run_dir/pass-fail-record.txt"; then
    issue "$platform" "The pass/fail record at ${run_dir}/pass-fail-record.txt is not PASS. Failed or blocked runner output is not reviewed device evidence; complete the run before release review."
  fi

  if [[ -s "$run_dir/pass-fail-record.txt" ]]; then
    local run_mode
    run_mode="$(metadata_value "$run_dir/pass-fail-record.txt" run_mode)"
    if [[ "$run_mode" == "diagnostic-only" ]]; then
      issue "$platform" "The pass/fail record at ${run_dir}/pass-fail-record.txt is from a diagnostic-only run (NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1), not release evidence. Re-run the release gate on the smallest supported device without the override."
    elif [[ "$run_mode" != "release-gate" ]]; then
      issue "$platform" "The pass/fail record at ${run_dir}/pass-fail-record.txt does not declare run_mode=release-gate. Only release-gate runs on the smallest supported device are release evidence; re-run the current native large-text gate."
    fi
  fi

  if [[ -s "$run_dir/native-branding-check.md" ]] &&
    ! grep -Fq -- "- Status: **PASS**" "$run_dir/native-branding-check.md"; then
    issue "$platform" "The native branding report at ${run_dir}/native-branding-check.md is not PASS. Resolve the native metadata failure and rerun the release gate."
  fi

  if [[ -s "$run_dir/maestro-results.xml" ]] &&
    ! grep -Eq '<testsuite([[:space:]>])' "$run_dir/maestro-results.xml"; then
    issue "$platform" "The JUnit result at ${run_dir}/maestro-results.xml is not a recognizable testsuite report. Upload the complete Maestro JUnit output."
  fi

  if [[ -s "$run_dir/sentry-maestro-results.xml" ]] &&
    ! grep -Eq '<testsuite([[:space:]>])' "$run_dir/sentry-maestro-results.xml"; then
    issue "$platform" "The controlled Sentry probe JUnit result at ${run_dir}/sentry-maestro-results.xml is not a recognizable testsuite report."
  fi

  if [[ -s "$run_dir/runner-metadata.txt" ]]; then
    local actual_platform
    local required_key
    local required_keys=(platform candidate_build_id recorded_at_utc)
    actual_platform="$(metadata_value "$run_dir/runner-metadata.txt" platform)"
    if [[ "$actual_platform" != "$platform" ]]; then
      issue "$platform" "Runner metadata identifies platform '${actual_platform:-missing}', not '${platform}'. Upload metadata from the matching platform run."
    fi
    for required_key in "${required_keys[@]}"; do
      if [[ -z "$(metadata_value "$run_dir/runner-metadata.txt" "$required_key")" ]]; then
        issue "$platform" "Runner metadata is missing ${required_key}=... in ${run_dir}/runner-metadata.txt. Device details and run identity must be recorded before review."
      fi
    done
    if [[ "$platform" == "ios" ]]; then
      required_keys=(device)
    else
      required_keys=(device_serial device_model android_release android_api screen_dp density_dpi user_rotation)
    fi
    for required_key in "${required_keys[@]}"; do
      if [[ -z "$(metadata_value "$run_dir/runner-metadata.txt" "$required_key")" ]]; then
        issue "$platform" "Runner metadata is missing ${required_key}=... in ${run_dir}/runner-metadata.txt. Record the tested device details before review."
      fi
    done
  fi

  if [[ -s "$run_dir/sentry-source-map-evidence.json" ]]; then
    local candidate_build_id
    local sentry_validation_output
    candidate_build_id="$(tr -d '\r\n' < "$run_dir/candidate-build-id.txt")"
    if ! sentry_validation_output="$(
      node --input-type=module - \
        "$run_dir/sentry-source-map-evidence.json" \
        "$run_dir/sentry-trigger.txt" \
        "$platform" \
        "$candidate_build_id" <<'NODE'
import { readFileSync } from "node:fs";

const [, , evidencePath, triggerPath, platform, candidateBuildId] = process.argv;
const rawEvidence = readFileSync(evidencePath, "utf8");
if (/(?:auth(?:orization)?[_-]?token|sentry_auth_token|bearer\s+[A-Za-z0-9._-]+)/i.test(rawEvidence)) {
  throw new Error("evidence contains credential-like content");
}
const evidence = JSON.parse(rawEvidence);
const trigger = Object.fromEntries(
  readFileSync(triggerPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const requiredStrings = [
  "eventId",
  "marker",
  "release",
  "dist",
];
if (evidence.status !== "PASS") throw new Error("status is not PASS");
if (evidence.platform !== platform) throw new Error("platform does not match");
if (evidence.candidateBuildId !== candidateBuildId) {
  throw new Error("candidate build ID does not match");
}
if (trigger.platform !== platform) throw new Error("trigger platform does not match");
if (trigger.candidate_build_id !== candidateBuildId) {
  throw new Error("trigger candidate build ID does not match");
}
if (trigger.marker !== evidence.marker) throw new Error("trigger marker does not match");
for (const key of requiredStrings) {
  if (typeof evidence[key] !== "string" || evidence[key].trim() === "") {
    throw new Error(`${key} is missing`);
  }
}
const frame = evidence.readableFrame;
if (
  !frame ||
  typeof frame.filename !== "string" ||
  !/\.[cm]?[jt]sx?$/i.test(frame.filename) ||
  typeof frame.function !== "string" ||
  !frame.function.includes("createNativeSourceMapProbeError") ||
  !Number.isInteger(frame.line) ||
  !Number.isInteger(frame.column)
) {
  throw new Error("readable source-mapped frame is missing");
}
NODE
    )"; then
      issue "$platform" "Invalid Sentry source-map evidence at ${run_dir}/sentry-source-map-evidence.json: ${sentry_validation_output:-validation failed}."
    fi
  fi

  local native_screenshot_dir="$run_dir/screenshots"
  local native_screenshot_count=0
  local native_empty_count=0
  if [[ -d "$native_screenshot_dir" ]]; then
    native_screenshot_count="$(find "$native_screenshot_dir" -type f -name '*.png' | wc -l | tr -d ' ')"
    native_empty_count="$(find "$native_screenshot_dir" -type f -name '*.png' -size 0c | wc -l | tr -d ' ')"
  fi
  if ((native_screenshot_count < 11)); then
    issue "$platform" "Expected at least 11 native screenshots in ${native_screenshot_dir}, found ${native_screenshot_count}. Re-run the complete flow and upload every screen capture."
  fi
  if ((native_empty_count > 0)); then
    issue "$platform" "Found ${native_empty_count} empty native screenshot file(s) in ${native_screenshot_dir}. Replace them with captures from the reviewed device run."
  fi

  local call_screenshot_dir="$run_dir/call-surface"
  local call_screenshot_count=0
  local call_empty_count=0
  if [[ -d "$call_screenshot_dir" ]]; then
    call_screenshot_count="$(find "$call_screenshot_dir" -type f -name '*.png' | wc -l | tr -d ' ')"
    call_empty_count="$(find "$call_screenshot_dir" -type f -name '*.png' -size 0c | wc -l | tr -d ' ')"
  fi
  if ((call_screenshot_count != 2)); then
    issue "$platform" "Expected exactly 2 call-surface screenshots in ${call_screenshot_dir}, found ${call_screenshot_count}. Capture both the embedded WebView and independent call layout."
  fi
  if ((call_empty_count > 0)); then
    issue "$platform" "Found ${call_empty_count} empty call-surface screenshot file(s) in ${call_screenshot_dir}. Replace them with captures from the reviewed device run."
  fi

  validate_review_record "$platform" "$run_dir"
}

# The automated artifacts prove that the expected files were uploaded. The
# review record proves that a person looked at the screenshots and the
# platform-specific findings, and preserves that release decision next to the
# evidence it covers.
validate_review_record() {
  local platform="$1"
  local run_dir="$2"
  local record_path="$run_dir/review-record.txt"
  local required_key
  local value
  local record_valid=1

  if [[ ! -e "$record_path" ]]; then
    REVIEW_PENDING_PLATFORMS+=("$platform")
    if [[ "$REQUIRE_APPROVAL" == "1" ]]; then
      issue "$platform" "Required approval missing: ${record_path} does not exist. Store submission requires an APPROVED review record for this candidate build. After reviewing the run, complete review-record.template.txt and rename it to review-record.txt."
    else
      notice "$platform" "Review record missing: ${record_path} does not exist. No person has recorded a review of this run's native screenshots, call-surface screenshots, and platform-specific findings, so it is not yet reviewed device evidence. After reviewing the run, complete review-record.template.txt and rename it to review-record.txt."
    fi
    return
  fi
  if [[ ! -s "$record_path" ]]; then
    issue "$platform" "Empty review record: ${record_path}. Record reviewer=, reviewed_at_utc=, candidate_build_id=, and decision=APPROVED or REJECTED, or remove the file until the review is done."
    return
  fi

  local reviewer reviewed_at decision record_build_id record_platform approval_scope notes
  reviewer="$(trimmed_value "$record_path" reviewer)"
  reviewed_at="$(trimmed_value "$record_path" reviewed_at_utc)"
  decision="$(trimmed_value "$record_path" decision)"
  record_build_id="$(trimmed_value "$record_path" candidate_build_id)"
  record_platform="$(trimmed_value "$record_path" platform)"
  approval_scope="$(trimmed_value "$record_path" approval_scope)"
  notes="$(trimmed_value "$record_path" notes)"

  for required_key in reviewer reviewed_at_utc candidate_build_id decision; do
    value="$(trimmed_value "$record_path" "$required_key")"
    if [[ -z "$value" ]]; then
      issue "$platform" "Review record is missing ${required_key}=... in ${record_path}. Record who reviewed the evidence, when, which candidate build, and the decision."
      record_valid=0
    elif [[ "$value" =~ $TEMPLATE_PLACEHOLDER_PATTERN ]]; then
      issue "$platform" "Review record still contains the template placeholder for ${required_key} in ${record_path}. Replace it with the real value."
      record_valid=0
    fi
  done

  if [[ -n "$record_platform" && "$record_platform" != "$platform" ]]; then
    issue "$platform" "Review record identifies platform '${record_platform}', not '${platform}', in ${record_path}. Each platform run needs its own review record."
    record_valid=0
  fi

  if [[ -n "$approval_scope" && "$approval_scope" != "candidate" ]]; then
    issue "$platform" "Review record approval_scope '${approval_scope}' in ${record_path} is not supported. Omit approval_scope for a per-run review or use approval_scope=candidate for a publish approval keyed to the candidate build ID."
    record_valid=0
  fi

  if [[ -n "$reviewed_at" && ! "$reviewed_at" =~ $UTC_TIMESTAMP_PATTERN ]]; then
    issue "$platform" "Review record reviewed_at_utc '${reviewed_at}' in ${record_path} is not a UTC timestamp such as 2026-09-10T14:05:00Z. Record the review time with: date -u +%Y-%m-%dT%H:%M:%SZ"
    record_valid=0
  fi

  local tested_build_id=""
  if [[ -s "$run_dir/candidate-build-id.txt" ]]; then
    tested_build_id="$(first_line_trimmed "$run_dir/candidate-build-id.txt")"
  fi
  if [[ -n "$record_build_id" && -n "$tested_build_id" && "$record_build_id" != "$tested_build_id" ]]; then
    issue "$platform" "Review record candidate_build_id '${record_build_id}' does not match the tested candidate '${tested_build_id}' in ${run_dir}/candidate-build-id.txt. A review covers one evidence set; do not reuse a review record from another build."
    record_valid=0
  fi

  # The pass/fail record is written when the run finishes, so it is the latest
  # time the evidence could have been produced. Fall back to the runner metadata
  # for runs that never wrote a completion time.
  local evidence_recorded_at=""
  if [[ -s "$run_dir/pass-fail-record.txt" ]]; then
    evidence_recorded_at="$(trimmed_value "$run_dir/pass-fail-record.txt" recorded_at_utc)"
  fi
  if [[ -z "$evidence_recorded_at" && -s "$run_dir/runner-metadata.txt" ]]; then
    evidence_recorded_at="$(trimmed_value "$run_dir/runner-metadata.txt" recorded_at_utc)"
  fi
  if [[ "$reviewed_at" =~ $UTC_TIMESTAMP_PATTERN && "$evidence_recorded_at" =~ $UTC_TIMESTAMP_PATTERN && "$reviewed_at" < "$evidence_recorded_at" ]]; then
    issue "$platform" "Review record reviewed_at_utc ${reviewed_at} predates the evidence recorded at ${evidence_recorded_at} in ${run_dir}. A review must happen after the run it covers; review this run and record a new decision."
    record_valid=0
  fi

  case "$decision" in
    APPROVED | "")
      ;;
    REJECTED)
      issue "$platform" "The review record at ${record_path} records decision=REJECTED by ${reviewer:-an unnamed reviewer} at ${reviewed_at:-an unrecorded time}${notes:+ (notes: ${notes})}. A rejected review blocks release; resolve the recorded findings, rerun the native large-text gate, and record a new review."
      record_valid=0
      ;;
    *)
      issue "$platform" "Review record decision '${decision}' in ${record_path} is not APPROVED or REJECTED. Record an explicit decision."
      record_valid=0
      ;;
  esac

  if ((record_valid)); then
    REVIEW_DECISIONS+=("[${platform}] Review record: APPROVED by ${reviewer} at ${reviewed_at} for candidate ${record_build_id}.")
  fi
}

echo "Checking native large-text evidence under ${RESULTS_ROOT}"
if [[ "$REQUIRE_APPROVAL" == "1" ]]; then
  echo "Strict review mode enabled: both platform evidence sets require an APPROVED review record."
fi
validate_platform ios
validate_platform android

if ((FAILURE_COUNT > 0)); then
  echo "Native large-text evidence completeness check FAILED with ${FAILURE_COUNT} issue(s)." >&2
  echo "Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts." >&2
  exit 1
fi

echo "Native large-text evidence completeness check passed for iOS and Android."
if ((${#REVIEW_DECISIONS[@]} > 0)); then
  printf '%s\n' "${REVIEW_DECISIONS[@]}"
fi
if ((${#REVIEW_PENDING_PLATFORMS[@]} > 0)); then
  echo "Review pending for: ${REVIEW_PENDING_PLATFORMS[*]}. The automated evidence is complete, but no person has recorded a release decision for it; complete review-record.template.txt and rename it to review-record.txt in each run directory before treating it as reviewed device evidence." >&2
fi