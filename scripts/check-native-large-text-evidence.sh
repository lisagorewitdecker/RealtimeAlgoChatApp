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

# Runner metadata and pass/fail records are machine-generated key=value files
# that declare each field once. A repeated key means two runs' output were
# merged or the file was edited, so the checker refuses to pick either value.
metadata_declaration_count() {
  local metadata_path="$1"
  local key="$2"
  awk -v key="$key" '
    {
      sub(/\r$/, "")
      if (index($0, key "=") == 1) count++
    }
    END { print count + 0 }
  ' "$metadata_path"
}

metadata_key_is_unambiguous() {
  local metadata_path="$1"
  local key="$2"
  (($(metadata_declaration_count "$metadata_path" "$key") <= 1))
}

# Prints "<count>\t<key>" for every key declared more than once, in first-seen
# order, so no field can hide a conflicting value behind first-match parsing.
duplicate_metadata_keys() {
  local metadata_path="$1"
  awk '
    {
      sub(/\r$/, "")
      separator = index($0, "=")
      if (separator < 2) next
      key = substr($0, 1, separator - 1)
      if (key ~ /[[:space:]]/) next
      count[key]++
      if (count[key] == 2) order[++duplicates] = key
    }
    END {
      for (i = 1; i <= duplicates; i++) printf "%d\t%s\n", count[order[i]], order[i]
    }
  ' "$metadata_path"
}

report_duplicate_metadata_keys() {
  local platform="$1"
  local metadata_path="$2"
  local file_label="$3"
  local file_noun="$4"
  local count
  local key

  while IFS=$'\t' read -r count key; do
    [[ -n "$key" ]] || continue
    issue "$platform" "${file_label} has ${count} ${key} declarations in ${metadata_path}. Declare ${key}=... at most once so the ${file_noun} is unambiguous; regenerate it from a single completed run instead of merging or editing results."
  done < <(duplicate_metadata_keys "$metadata_path")
}

# Hand-written review records may carry Windows line endings or stray spaces.
trimmed_value() {
  local metadata_path="$1"
  local key="$2"
  metadata_value "$metadata_path" "$key" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

review_notes_declaration_count() {
  local record_path="$1"

  awk '
    {
      sub(/\r$/, "")
      if (in_notes) {
        if ($0 == delimiter) in_notes = 0
        next
      }
      if ($0 ~ /^notes=/) {
        count++
        next
      }
      if ($0 ~ /^notes<</) {
        count++
        delimiter = substr($0, length("notes<<") + 1)
        if (delimiter != "") in_notes = 1
      }
    }
    END { print count + 0 }
  ' "$record_path"
}

review_field_declaration_count() {
  local record_path="$1"
  local key="$2"

  awk -v key="$key" '
    {
      sub(/\r$/, "")
      if (in_notes) {
        if ($0 == delimiter) in_notes = 0
        next
      }
      if ($0 ~ /^notes<</) {
        delimiter = substr($0, length("notes<<") + 1)
        if (delimiter != "") in_notes = 1
        next
      }
      if (index($0, key "=") == 1) count++
    }
    END { print count + 0 }
  ' "$record_path"
}

review_field_value() {
  local record_path="$1"
  local key="$2"

  awk -v key="$key" '
    {
      sub(/\r$/, "")
      if (in_notes) {
        if ($0 == delimiter) in_notes = 0
        next
      }
      if ($0 ~ /^notes<</) {
        delimiter = substr($0, length("notes<<") + 1)
        if (delimiter != "") in_notes = 1
        next
      }
      if (index($0, key "=") == 1) {
        print substr($0, length(key) + 2)
        exit
      }
    }
  ' "$record_path" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

review_notes() {
  local record_path="$1"
  local block_declaration
  local delimiter

  block_declaration="$(sed -n '/^notes<</{p;q;}' "$record_path" | tr -d '\r')"
  if [[ -n "$block_declaration" ]]; then
    delimiter="${block_declaration#notes<<}"
    if [[ -n "$delimiter" ]]; then
      awk -v declaration="$block_declaration" -v delimiter="$delimiter" '
        BEGIN { in_notes = 0 }
        {
          sub(/\r$/, "")
          if (!in_notes && $0 == declaration) {
            in_notes = 1
            next
          }
          if (in_notes && $0 == delimiter) exit
          if (in_notes) print
        }
      ' "$record_path"
      return
    fi
  fi

  trimmed_value "$record_path" notes
}

review_notes_block_is_closed() {
  local record_path="$1"
  local block_declaration
  local delimiter

  block_declaration="$(sed -n '/^notes<</{p;q;}' "$record_path" | tr -d '\r')"
  [[ -z "$block_declaration" ]] && return 0

  delimiter="${block_declaration#notes<<}"
  [[ -n "$delimiter" ]] || return 1
  awk -v declaration="$block_declaration" -v delimiter="$delimiter" '
    {
      sub(/\r$/, "")
      if (!opened && $0 == declaration) {
        opened = 1
        next
      }
      if (opened && $0 == delimiter) {
        closed = 1
        exit
      }
    }
    END { exit !closed }
  ' "$record_path"
}

print_literal_evidence() {
  local platform="$1"
  local text="$2"

  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[%s]   | %s\n' "$platform" "$line" >&2
  done <<<"$text"
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

  if [[ -s "$run_dir/pass-fail-record.txt" ]]; then
    local pass_fail_path="$run_dir/pass-fail-record.txt"
    report_duplicate_metadata_keys "$platform" "$pass_fail_path" "Pass/fail record" "pass/fail record"

    if metadata_key_is_unambiguous "$pass_fail_path" status &&
      [[ "$(metadata_value "$pass_fail_path" status | tr -d '\r' | sed 's/[[:space:]]*$//')" != "PASS" ]]; then
      issue "$platform" "The pass/fail record at ${pass_fail_path} is not PASS. Failed or blocked runner output is not reviewed device evidence; complete the run before release review."
    fi

    local run_mode
    if metadata_key_is_unambiguous "$pass_fail_path" run_mode; then
      run_mode="$(metadata_value "$pass_fail_path" run_mode)"
      if [[ "$run_mode" == "diagnostic-only" ]]; then
        issue "$platform" "The pass/fail record at ${pass_fail_path} is from a diagnostic-only run (NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1), not release evidence. Re-run the release gate on the smallest supported device without the override."
      elif [[ "$run_mode" != "release-gate" ]]; then
        issue "$platform" "The pass/fail record at ${pass_fail_path} does not declare run_mode=release-gate. Only release-gate runs on the smallest supported device are release evidence; re-run the current native large-text gate."
      fi
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
    local runner_metadata_path="$run_dir/runner-metadata.txt"
    local actual_platform
    local required_key
    local required_keys=(platform candidate_build_id recorded_at_utc)
    report_duplicate_metadata_keys "$platform" "$runner_metadata_path" "Runner metadata" "runner metadata"
    if metadata_key_is_unambiguous "$runner_metadata_path" platform; then
      actual_platform="$(metadata_value "$runner_metadata_path" platform)"
      if [[ "$actual_platform" != "$platform" ]]; then
        issue "$platform" "Runner metadata identifies platform '${actual_platform:-missing}', not '${platform}'. Upload metadata from the matching platform run."
      fi
    fi
    for required_key in "${required_keys[@]}"; do
      if metadata_key_is_unambiguous "$runner_metadata_path" "$required_key" &&
        [[ -z "$(metadata_value "$runner_metadata_path" "$required_key")" ]]; then
        issue "$platform" "Runner metadata is missing ${required_key}=... in ${run_dir}/runner-metadata.txt. Device details and run identity must be recorded before review."
      fi
    done
    if [[ "$platform" == "ios" ]]; then
      required_keys=(device)
    else
      required_keys=(device_serial device_model android_release android_api screen_dp density_dpi user_rotation)
    fi
    for required_key in "${required_keys[@]}"; do
      if metadata_key_is_unambiguous "$runner_metadata_path" "$required_key" &&
        [[ -z "$(metadata_value "$runner_metadata_path" "$required_key")" ]]; then
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

  local reviewer="" reviewed_at="" decision="" record_build_id="" record_platform="" approval_scope=""
  local notes notes_declaration_count declaration_count
  local single_value_key
  notes_declaration_count="$(review_notes_declaration_count "$record_path")"
  notes=""

  for single_value_key in platform reviewer reviewed_at_utc candidate_build_id decision approval_scope; do
    declaration_count="$(review_field_declaration_count "$record_path" "$single_value_key")"
    if ((declaration_count > 1)); then
      issue "$platform" "Review record has ${declaration_count} ${single_value_key} declarations in ${record_path}. Declare ${single_value_key}=... at most once so the review record is unambiguous."
      record_valid=0
    elif ((declaration_count == 1)); then
      case "$single_value_key" in
        platform) record_platform="$(review_field_value "$record_path" "$single_value_key")" ;;
        reviewer) reviewer="$(review_field_value "$record_path" "$single_value_key")" ;;
        reviewed_at_utc) reviewed_at="$(review_field_value "$record_path" "$single_value_key")" ;;
        candidate_build_id) record_build_id="$(review_field_value "$record_path" "$single_value_key")" ;;
        decision) decision="$(review_field_value "$record_path" "$single_value_key")" ;;
        approval_scope) approval_scope="$(review_field_value "$record_path" "$single_value_key")" ;;
      esac
    fi
  done

  if ((notes_declaration_count > 1)); then
    issue "$platform" "Review record has ${notes_declaration_count} notes declarations in ${record_path}. Use exactly one notes=... line or one notes<<... block so the review finding is unambiguous."
    record_valid=0
  else
    notes="$(review_notes "$record_path")"
  fi

  if ! review_notes_block_is_closed "$record_path"; then
    issue "$platform" "Review record has an unterminated notes block in ${record_path}. Close it with the exact delimiter named after notes<<."
    record_valid=0
  fi

  for required_key in reviewer reviewed_at_utc candidate_build_id decision; do
    declaration_count="$(review_field_declaration_count "$record_path" "$required_key")"
    ((declaration_count > 1)) && continue
    value="$(review_field_value "$record_path" "$required_key")"
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
  if [[ -s "$run_dir/pass-fail-record.txt" ]] &&
    metadata_key_is_unambiguous "$run_dir/pass-fail-record.txt" recorded_at_utc; then
    evidence_recorded_at="$(trimmed_value "$run_dir/pass-fail-record.txt" recorded_at_utc)"
  fi
  if [[ -z "$evidence_recorded_at" && -s "$run_dir/runner-metadata.txt" ]] &&
    metadata_key_is_unambiguous "$run_dir/runner-metadata.txt" recorded_at_utc; then
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
      issue "$platform" "The review record at ${record_path} records decision=REJECTED by ${reviewer:-an unnamed reviewer} at ${reviewed_at:-an unrecorded time}. A rejected review blocks release; resolve the recorded findings, rerun the native large-text gate, and record a new review."
      if [[ -n "$notes" ]]; then
        printf '[%s] Review notes (literal evidence):\n' "$platform" >&2
        print_literal_evidence "$platform" "$notes"
      fi
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