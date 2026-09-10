#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${1:-$ROOT_DIR/test-results/native-large-text}"
FAILURE_COUNT=0

issue() {
  local platform="$1"
  shift
  printf '[%s] %s\n' "$platform" "$*" >&2
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
}

metadata_value() {
  local metadata_path="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$metadata_path" | head -n 1
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
      issue "$platform" "Only runner-check.txt is present in ${platform_dir}. It is blocked runner diagnostics, not reviewed device evidence; run on a prepared ${platform} runner and upload the timestamped result directory."
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
}

echo "Checking native large-text evidence under ${RESULTS_ROOT}"
validate_platform ios
validate_platform android

if ((FAILURE_COUNT > 0)); then
  echo "Native large-text evidence completeness check FAILED with ${FAILURE_COUNT} issue(s)." >&2
  echo "Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts." >&2
  exit 1
fi

echo "Native large-text evidence completeness check passed for iOS and Android."