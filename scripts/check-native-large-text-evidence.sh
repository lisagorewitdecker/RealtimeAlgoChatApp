#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${1:-$ROOT_DIR/test-results/native-large-text}"
FAILURE_COUNT=0
REVIEW_PENDING_PLATFORMS=()
REVIEW_DECISIONS=()
declare -A SUMMARY_ISSUES=([ios]="" [android]="")
declare -A SUMMARY_NOTICES=([ios]="" [android]="")
declare -A SUMMARY_RUN_DIR=([ios]="" [android]="")
declare -A SUMMARY_DOWNLOAD_STATUS=([ios]="" [android]="")
declare -A SUMMARY_NATIVE_SCREENSHOT_COUNT=([ios]=0 [android]=0)
declare -A SUMMARY_NATIVE_EMPTY_COUNT=([ios]=0 [android]=0)
declare -A SUMMARY_CALL_SCREENSHOT_COUNT=([ios]=0 [android]=0)
declare -A SUMMARY_CALL_EMPTY_COUNT=([ios]=0 [android]=0)
REQUIRE_APPROVAL="${NATIVE_EVIDENCE_REQUIRE_APPROVAL:-0}"
NODE_BINARY="${NATIVE_EVIDENCE_NODE_BINARY:-node}"
UTC_TIMESTAMP_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
TEMPLATE_PLACEHOLDER_PATTERN='^<.*>$'
NATIVE_EVIDENCE_REPORT_NAME="native-branding-check.md"
SHA256_PATTERN='^[0-9a-f]{64}$'
TRUSTED_EVIDENCE_PATH_PATTERN='^(candidate-build-id\.txt|runner-metadata\.txt|pass-fail-record\.txt|review-record\.template\.txt|native-info\.json|native-branding-check\.md|ios-readiness\.md|android-badging\.txt|maestro-results\.xml|sentry-maestro-results\.xml|sentry-trigger\.txt|sentry-source-map-evidence\.json|screenshots/[A-Za-z0-9._-]+\.png|call-surface/[A-Za-z0-9._-]+\.png)$'

# The recovery wording is also consumed by the release workflow's contract
# checks. Keep reviewer-facing guidance identical across both boundaries.
source "$ROOT_DIR/scripts/native-release-recovery-contract.sh"

if [[ "$REQUIRE_APPROVAL" != "0" && "$REQUIRE_APPROVAL" != "1" ]]; then
  echo "NATIVE_EVIDENCE_REQUIRE_APPROVAL must be 0 or 1." >&2
  exit 2
fi

record_summary_issue() {
  local platform="$1"
  shift
  SUMMARY_ISSUES["$platform"]+="$*"$'\n'
}

record_summary_notice() {
  local platform="$1"
  shift
  SUMMARY_NOTICES["$platform"]+="$*"$'\n'
}

summary_safe_text() {
  local value="$1"
  value="$(printf '%s' "$value" | LC_ALL=C tr '\000-\011\013-\037\177' ' ' | tr '\140' "'")"
  printf '%s' "$value"
}

summary_artifact_url() {
  local platform="$1"
  local artifact_url=""
  local download_result=""
  local download_result_is_set=0

  if [[ "$platform" == "ios" ]]; then
    artifact_url="${NATIVE_IOS_EVIDENCE_ARTIFACT_URL:-}"
    if [[ -v NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT ]]; then
      download_result_is_set=1
      download_result="${NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT}"
    fi
  else
    artifact_url="${NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL:-}"
    if [[ -v NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT ]]; then
      download_result_is_set=1
      download_result="${NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT}"
    fi
  fi

  if ((download_result_is_set)) && [[ "$download_result" != "success" ]]; then
    return 0
  fi

  # The URL comes from actions/upload-artifact. Keep the link target limited
  # to the GitHub artifact page shape so evidence or other runtime text cannot
  # become Markdown link destinations.
  if [[ "$artifact_url" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+/artifacts/[0-9]+$ ]]; then
    printf '%s' "$artifact_url"
  fi
}

record_download_status() {
  local platform="$1"
  local label="$2"
  local download_result=""

  if [[ "$platform" == "ios" ]]; then
    [[ -v NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT ]] || return 0
    download_result="${NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT}"
  else
    [[ -v NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT ]] || return 0
    download_result="${NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT}"
  fi

  if [[ "$download_result" == "success" ]]; then
    SUMMARY_DOWNLOAD_STATUS["$platform"]="PASS"
    return 0
  fi

  SUMMARY_DOWNLOAD_STATUS["$platform"]="FAIL"
  issue "$platform" "The ${label} native evidence artifact download did not complete. The artifact may have expired; the downloaded ${label} evidence is unavailable; rerun the release gate after the artifact is available."
}

trusted_digest_manifest() {
  if [[ "$1" == "ios" ]]; then
    printf '%s' "${NATIVE_IOS_EVIDENCE_DIGEST_MANIFEST:-}"
  else
    printf '%s' "${NATIVE_ANDROID_EVIDENCE_DIGEST_MANIFEST:-}"
  fi
}

file_sha256() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{ print $1 }'
  else
    return 1
  fi
}

validate_trusted_digest_manifest() {
  local platform="$1"
  local run_dir="$2"
  local manifest
  local line
  local digest
  local relative_path
  local actual_path
  local actual_digest
  local manifest_error=0
  local manifest_entry_count=0
  local actual_file_count=0
  local -a manifest_paths=()
  declare -A manifest_digests=()
  declare -A actual_files=()

  # The native jobs calculate this manifest before upload and expose it as a
  # job output. It is intentionally not stored beside the downloaded files:
  # changing the artifact must not let a publisher change the expected hashes.
  manifest="$(trusted_digest_manifest "$platform")"
  if [[ -z "$manifest" ]]; then
    issue "$platform" "Strict evidence validation is missing the trusted digest manifest for the downloaded native evidence. Regenerate the release evidence from the native job before submission."
    return
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$line" =~ ^([0-9a-f]{64})[[:space:]][[:space:]](.+)$ ]]; then
      digest="${BASH_REMATCH[1]}"
      relative_path="${BASH_REMATCH[2]}"
    else
      manifest_error=1
      continue
    fi
    if [[ ! "$relative_path" =~ $TRUSTED_EVIDENCE_PATH_PATTERN ]] ||
      [[ -v "manifest_digests[$relative_path]" ]]; then
      manifest_error=1
      continue
    fi
    manifest_paths+=("$relative_path")
    manifest_digests["$relative_path"]="$digest"
    manifest_entry_count=$((manifest_entry_count + 1))
  done <<< "$manifest"

  while IFS= read -r -d '' actual_path; do
    relative_path="${actual_path#"$run_dir"/}"
    [[ "$relative_path" == "review-record.txt" ]] && continue
    if [[ ! "$relative_path" =~ $TRUSTED_EVIDENCE_PATH_PATTERN ]]; then
      manifest_error=1
      continue
    fi
    actual_files["$relative_path"]=1
    actual_file_count=$((actual_file_count + 1))
    if [[ -z "${manifest_digests[$relative_path]+set}" ]]; then
      manifest_error=1
      continue
    fi
    actual_digest="$(file_sha256 "$actual_path" || true)"
    if [[ ! "$actual_digest" =~ $SHA256_PATTERN ]] ||
      [[ "$actual_digest" != "${manifest_digests[$relative_path]}" ]]; then
      manifest_error=1
    fi
  done < <(find "$run_dir" -type f -print0 | sort -z)

  for relative_path in "${manifest_paths[@]}"; do
    if [[ -z "${actual_files[$relative_path]+set}" ]]; then
      manifest_error=1
    fi
  done

  if ((manifest_error)) || ((manifest_entry_count != actual_file_count)); then
    issue "$platform" "A downloaded native evidence file does not match the trusted digest manifest for ${run_dir}. Redownload the evidence from the release gate; do not edit or merge evidence files before submission."
  fi
}

issue() {
  local platform="$1"
  shift
  record_summary_issue "$platform" "$*"
  printf '[%s] %s\n' "$platform" "$*" >&2
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
}

notice() {
  local platform="$1"
  shift
  record_summary_notice "$platform" "$*"
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

# Prints the declaration count for every duplicated key, in first-seen order.
# Do not pass the key through the diagnostic boundary: metadata is untrusted
# input, and control characters in a field name could reshape the release log.
duplicate_metadata_keys() {
  local metadata_path="$1"
  awk '
    {
      sub(/\r$/, "")
      separator = index($0, "=")
      if (separator < 2) next
      key = substr($0, 1, separator - 1)
      count[key]++
      if (count[key] == 2) order[++duplicates] = key
    }
    END {
      for (i = 1; i <= duplicates; i++) print count[order[i]]
    }
  ' "$metadata_path"
}

report_duplicate_metadata_keys() {
  local platform="$1"
  local metadata_path="$2"
  local file_label="$3"
  local file_noun="$4"
  local count

  while IFS= read -r count; do
    [[ -n "$count" ]] || continue
    issue "$platform" "${file_label} contains a duplicate field (${count} declarations) in ${metadata_path}. Keep each ${file_noun} field to one declaration; regenerate it from a single completed run instead of merging or editing results."
  done < <(duplicate_metadata_keys "$metadata_path")
}

# sentry-trigger.txt is produced by the controlled probe and must contain only
# the three declarations consumed by the source-map evidence check. Report
# structure and line numbers, but never include the line contents or values.
sentry_trigger_metadata_errors() {
  local metadata_path="$1"
  awk '
    {
      line = $0
      sub(/\r$/, "", line)
      separator_count = gsub(/=/, "=", line)
      if (line == "") {
        printf "%d\tempty line\n", NR
        next
      }
      if (separator_count != 1) {
        printf "%d\texpected exactly one key=value declaration\n", NR
        next
      }

      separator = index(line, "=")
      key = substr(line, 1, separator - 1)
      value = substr(line, separator + 1)
      if (key == "" || value ~ /^[[:space:]]*$/) {
        printf "%d\tkey and value must both be non-empty\n", NR
        next
      }
      if (key ~ /[[:space:]]/) {
        printf "%d\tkey must not contain whitespace\n", NR
        next
      }
      if (key != "platform" && key != "candidate_build_id" && key != "marker") {
        printf "%d\tunknown key/value declaration\n", NR
      }
    }
  ' "$metadata_path"
}

report_sentry_trigger_metadata_errors() {
  local platform="$1"
  local metadata_path="$2"
  local line_number
  local reason

  while IFS=$'\t' read -r line_number reason; do
    [[ -n "$line_number" ]] || continue
    issue "$platform" "Sentry trigger metadata line ${line_number} in ${metadata_path} is malformed: ${reason}. Regenerate it from a completed controlled Sentry probe without editing the metadata."
  done < <(sentry_trigger_metadata_errors "$metadata_path")
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

first_line_trimmed() {
  head -n 1 "$1" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

candidate_build_id_file_is_valid() {
  local candidate_path="$1"

  awk '
    {
      sub(/\r$/, "")
      line_count++
      if ($0 !~ /^[[:space:]]*$/) non_empty_count++
    }
    END {
      exit !(line_count == 1 && non_empty_count == 1)
    }
  ' "$candidate_path"
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

  mapfile -d '' -t run_dirs < <(find "$platform_dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
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
  local run_dir_name="${run_dir##*/}"
  if [[ ! "$run_dir_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    issue "$platform" "Evidence run directory name in ${platform_dir} is unsafe. Use the generated release run directory name."
    return
  fi
  SUMMARY_RUN_DIR["$platform"]="$run_dir"

  check_required_file "$platform" "$run_dir" "candidate-build-id.txt" "candidate build ID"
  check_required_file "$platform" "$run_dir" "runner-metadata.txt" "runner metadata and device details"
  check_required_file "$platform" "$run_dir" "pass-fail-record.txt" "pass/fail record"
  check_required_file "$platform" "$run_dir" "native-info.json" "compiled native metadata"
  check_required_file "$platform" "$run_dir" "native-branding-check.md" "native branding report"
  check_required_file "$platform" "$run_dir" "maestro-results.xml" "JUnit result"
  check_required_file "$platform" "$run_dir" "sentry-maestro-results.xml" "controlled Sentry probe JUnit result"
  check_required_file "$platform" "$run_dir" "sentry-trigger.txt" "controlled Sentry probe metadata"
  check_required_file "$platform" "$run_dir" "sentry-source-map-evidence.json" "Sentry source-map evidence"
  if [[ "$REQUIRE_APPROVAL" == "1" ]]; then
    validate_trusted_digest_manifest "$platform" "$run_dir"
  fi

  local candidate_build_id_path="$run_dir/candidate-build-id.txt"
  local candidate_build_id_is_valid=0
  if [[ -s "$candidate_build_id_path" ]]; then
    if candidate_build_id_file_is_valid "$candidate_build_id_path"; then
      candidate_build_id_is_valid=1
    else
      issue "$platform" "Candidate build ID file at ${candidate_build_id_path} must contain exactly one non-empty identifier line. Regenerate it for one candidate build without merging or editing its contents."
    fi
  fi

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
        issue "$platform" "Runner metadata identifies the wrong platform in ${runner_metadata_path}. Upload metadata from the matching platform run."
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

  local sentry_trigger_path="$run_dir/sentry-trigger.txt"
  local sentry_trigger_has_errors=0
  if [[ -s "$sentry_trigger_path" ]]; then
    if [[ -n "$(sentry_trigger_metadata_errors "$sentry_trigger_path")" ]]; then
      sentry_trigger_has_errors=1
      report_sentry_trigger_metadata_errors "$platform" "$sentry_trigger_path"
    fi
    if [[ -n "$(duplicate_metadata_keys "$sentry_trigger_path")" ]]; then
      sentry_trigger_has_errors=1
      report_duplicate_metadata_keys "$platform" "$sentry_trigger_path" "Sentry trigger metadata" "Sentry trigger metadata"
    fi
  fi

  if [[ -s "$run_dir/sentry-source-map-evidence.json" ]] &&
    ((candidate_build_id_is_valid == 1)) &&
    ((sentry_trigger_has_errors == 0)); then
    local candidate_build_id
    local sentry_validation_output
    candidate_build_id="$(first_line_trimmed "$candidate_build_id_path")"
    if ! sentry_validation_output="$(
      "$NODE_BINARY" --input-type=module - \
        "$run_dir/sentry-source-map-evidence.json" \
        "$sentry_trigger_path" \
        "$platform" \
        "$candidate_build_id" \
        "$ROOT_DIR/scripts/find-duplicate-json-object-keys.mjs" \
        "$ROOT_DIR/scripts/read-bounded-text.mjs" 2>&1 <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [
  ,
  ,
  evidencePath,
  triggerPath,
  platform,
  candidateBuildId,
  duplicateKeysModulePath,
  boundedTextModulePath,
] = process.argv;
const { findDuplicateJsonObjectKeys } = await import(
  pathToFileURL(duplicateKeysModulePath).href
);
const { readBoundedTextFileSync } = await import(
  pathToFileURL(boundedTextModulePath).href
);
let rawEvidence;
try {
  rawEvidence = readBoundedTextFileSync(evidencePath);
} catch (error) {
  if (error?.code === "JSON_EVIDENCE_TOO_LARGE") {
    throw new Error("evidence exceeds the release evidence size limit");
  }
  throw error;
}
if (/(?:auth(?:orization)?[_-]?token|sentry_auth_token|bearer\s+[A-Za-z0-9._-]+)/i.test(rawEvidence)) {
  throw new Error("evidence contains credential-like content");
}
let duplicateFields;
try {
  duplicateFields = findDuplicateJsonObjectKeys(rawEvidence);
} catch (error) {
  if (error?.code === "JSON_EVIDENCE_TOO_LARGE") {
    throw new Error("evidence exceeds the release evidence size limit");
  }
  if (error?.code === "JSON_EVIDENCE_TOO_DEEP") {
    throw new Error("evidence exceeds the release evidence nesting limit");
  }
  throw error;
}
if (duplicateFields.length > 0) {
  throw new Error("duplicate JSON field(s)");
}
let evidence;
try {
  evidence = JSON.parse(rawEvidence);
} catch {
  throw new Error("evidence is not valid JSON");
}
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
  SUMMARY_NATIVE_SCREENSHOT_COUNT["$platform"]="$native_screenshot_count"
  SUMMARY_NATIVE_EMPTY_COUNT["$platform"]="$native_empty_count"
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
  SUMMARY_CALL_SCREENSHOT_COUNT["$platform"]="$call_screenshot_count"
  SUMMARY_CALL_EMPTY_COUNT["$platform"]="$call_empty_count"
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
    issue "$platform" "Review record identifies the wrong platform in ${record_path}. Each platform run needs its own review record."
    record_valid=0
  fi

  if [[ -n "$approval_scope" && "$approval_scope" != "candidate" ]]; then
    issue "$platform" "Review record contains an unsupported approval_scope in ${record_path}. Omit approval_scope for a per-run review or use approval_scope=candidate for a publish approval keyed to the candidate build ID."
    record_valid=0
  fi

  if [[ -n "$reviewed_at" && ! "$reviewed_at" =~ $UTC_TIMESTAMP_PATTERN ]]; then
    issue "$platform" "Review record reviewed_at_utc in ${record_path} is not a UTC timestamp such as 2026-09-10T14:05:00Z. Record the review time with: date -u +%Y-%m-%dT%H:%M:%SZ"
    record_valid=0
  fi

  local tested_build_id=""
  if [[ -s "$run_dir/candidate-build-id.txt" ]]; then
    tested_build_id="$(first_line_trimmed "$run_dir/candidate-build-id.txt")"
  fi
  if [[ -n "$record_build_id" && -n "$tested_build_id" && "$record_build_id" != "$tested_build_id" ]]; then
    issue "$platform" "Review record candidate_build_id does not match the tested candidate in ${run_dir}/candidate-build-id.txt. A review covers one evidence set; do not reuse a review record from another build."
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
    issue "$platform" "Review record reviewed_at_utc predates the evidence recorded_at_utc in ${run_dir}. A review must happen after the run it covers; review this run and record a new decision."
    record_valid=0
  fi

  case "$decision" in
    APPROVED | "")
      ;;
    REJECTED)
      issue "$platform" "The review record at ${record_path} records a rejected decision. A rejected review blocks release; resolve the recorded findings, rerun the native large-text gate, and record a new review."
      if [[ -n "$notes" ]]; then
        notice "$platform" "Review notes were supplied but are omitted from automated release output."
      fi
      record_valid=0
      ;;
    *)
      issue "$platform" "Review record contains an unsupported decision in ${record_path}. Record an explicit decision."
      record_valid=0
      ;;
  esac

  if ((record_valid)); then
    REVIEW_DECISIONS+=("[${platform}] Review record: APPROVED for the validated candidate.")
  fi
}

write_evidence_summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0

  local platform
  local label
  local status
  local run_dir
  local native_screenshot_count
  local native_empty_count
  local call_screenshot_count
  local call_empty_count
  local finding
  local safe_run_dir
  local safe_finding
  local evidence_artifact_url
  local download_status

  for platform in ios android; do
    if [[ "$platform" == "ios" ]]; then
      label="iOS"
    else
      label="Android"
    fi

    if [[ -n "${SUMMARY_ISSUES[$platform]}" ]]; then
      status="FAIL"
    else
      status="PASS"
    fi

    run_dir="${SUMMARY_RUN_DIR[$platform]}"
    native_screenshot_count="${SUMMARY_NATIVE_SCREENSHOT_COUNT[$platform]}"
    native_empty_count="${SUMMARY_NATIVE_EMPTY_COUNT[$platform]}"
    call_screenshot_count="${SUMMARY_CALL_SCREENSHOT_COUNT[$platform]}"
    call_empty_count="${SUMMARY_CALL_EMPTY_COUNT[$platform]}"
    safe_run_dir="$(summary_safe_text "$run_dir")"
    evidence_artifact_url="$(summary_artifact_url "$platform")"
    download_status="${SUMMARY_DOWNLOAD_STATUS[$platform]}"

    {
      echo "## ${label} native large-text evidence"
      echo
      echo "- Status: **${status}**"
      if [[ -n "$download_status" ]]; then
        echo "- Artifact download: **${download_status}**"
        if [[ "$download_status" == "FAIL" ]]; then
          echo "- Artifact link check: **EXPIRED OR UNAVAILABLE**"
        fi
      fi
      if [[ -n "$run_dir" ]]; then
        echo "- Validated run directory: \`${safe_run_dir}\`"
        if [[ -n "$evidence_artifact_url" ]]; then
          echo "- Detailed evidence report: [${NATIVE_EVIDENCE_REPORT_NAME}](${evidence_artifact_url})"
        else
          echo "- Detailed evidence report: **Unavailable**"
        fi
        echo "- Native screenshots: **${native_screenshot_count}** (minimum 11; empty: ${native_empty_count})"
        echo "- Call-surface screenshots: **${call_screenshot_count}** (required 2; empty: ${call_empty_count})"
      else
        echo "- Validated run directory: **Unavailable**"
        echo "- Detailed evidence report: **Unavailable**"
      fi
      if [[ "$download_status" == "FAIL" ]]; then
        native_release_recovery_line "$platform"
      fi
      if [[ -n "${SUMMARY_ISSUES[$platform]}" ]]; then
        echo
        echo "### Blocking evidence findings"
        while IFS= read -r finding; do
          [[ -n "$finding" ]] || continue
          safe_finding="$(summary_safe_text "$finding")"
          printf -- '- `%s`\n' "$safe_finding"
        done <<< "${SUMMARY_ISSUES[$platform]}"
      fi
      if [[ -n "${SUMMARY_NOTICES[$platform]}" ]]; then
        echo
        echo "### Review notices"
        while IFS= read -r finding; do
          [[ -n "$finding" ]] || continue
          safe_finding="$(summary_safe_text "$finding")"
          printf -- '- `%s`\n' "$safe_finding"
        done <<< "${SUMMARY_NOTICES[$platform]}"
      fi
      echo
    } >> "$GITHUB_STEP_SUMMARY"
  done
}

echo "Checking native large-text evidence under ${RESULTS_ROOT}"
if [[ "$REQUIRE_APPROVAL" == "1" ]]; then
  echo "Strict review mode enabled: both platform evidence sets require an APPROVED review record."
fi
record_download_status ios "iOS"
record_download_status android "Android"
validate_platform ios
validate_platform android
write_evidence_summary

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
