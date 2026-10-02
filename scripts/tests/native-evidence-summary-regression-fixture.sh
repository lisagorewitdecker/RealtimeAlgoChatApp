#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 CHECKER_COMMAND [ARG...]" >&2
  exit 2
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
blocked_root="$(mktemp -d)"
summary_path="$(mktemp)"
checker_stdout="$(mktemp)"
checker_stderr="$(mktemp)"
shell_marker_path="$blocked_root/unsafe-download-metadata-shell-marker"
trap 'rm -rf "$blocked_root" "$summary_path" "$checker_stdout" "$checker_stderr"' EXIT
resolved_commit_sha="$(git -C "$root_dir" rev-parse --verify HEAD)"
hostile_metadata="${NATIVE_EVIDENCE_HOSTILE_METADATA:-0}"
hostile_success_metadata="${NATIVE_EVIDENCE_HOSTILE_SUCCESS_METADATA:-0}"
summary_capture_path="${NATIVE_EVIDENCE_SUMMARY_CAPTURE_PATH:-}"

: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY to the job summary file.}"
: "${REVIEWED_REF:?Set REVIEWED_REF to the checked ref.}"

if [[ "$hostile_metadata" != "0" && "$hostile_metadata" != "1" ]]; then
  echo "NATIVE_EVIDENCE_HOSTILE_METADATA must be 0 or 1." >&2
  exit 2
fi
if [[ "$hostile_success_metadata" != "0" && "$hostile_success_metadata" != "1" ]]; then
  echo "NATIVE_EVIDENCE_HOSTILE_SUCCESS_METADATA must be 0 or 1." >&2
  exit 2
fi
if [[ "$hostile_metadata" == "1" && "$hostile_success_metadata" == "1" ]]; then
  echo "NATIVE_EVIDENCE_HOSTILE_METADATA and NATIVE_EVIDENCE_HOSTILE_SUCCESS_METADATA cannot both be 1." >&2
  exit 2
fi

{
  echo "## Reviewed release revision"
  printf -- '- Checked ref: `%s`\n' "$REVIEWED_REF"
  printf -- '- Resolved commit SHA: `%s`\n' "$resolved_commit_sha"
} >> "$GITHUB_STEP_SUMMARY"

decode_probe() {
  printf '%s' "$1" | base64 --decode
}

write_success_evidence() {
  local platform="$1"
  local run_dir="$blocked_root/$platform/20260921T120000Z"
  local candidate_build_id="fixture-$platform"
  local index

  mkdir -p "$run_dir/screenshots" "$run_dir/call-surface"
  printf '%s\n' "$candidate_build_id" > "$run_dir/candidate-build-id.txt"
  cat > "$run_dir/runner-metadata.txt" <<EOF
platform=$platform
candidate_build_id=$candidate_build_id
recorded_at_utc=2026-09-21T12:00:00Z
EOF
  if [[ "$platform" == "ios" ]]; then
    printf '%s\n' "device=iPhone 16e" >> "$run_dir/runner-metadata.txt"
  else
    cat >> "$run_dir/runner-metadata.txt" <<'EOF'
device_serial=fixture-android
device_model=Pixel 9
android_release=16
android_api=36
screen_dp=393x852
density_dpi=420
user_rotation=0
EOF
  fi
  cat > "$run_dir/pass-fail-record.txt" <<EOF
platform=$platform
status=PASS
run_mode=release-gate
recorded_at_utc=2026-09-21T12:00:00Z
EOF
  printf '{}\n' > "$run_dir/native-info.json"
  printf '%s\n' '- Status: **PASS**' > "$run_dir/native-branding-check.md"
  printf '%s\n' '<testsuite name="native-large-text"/>' > "$run_dir/maestro-results.xml"
  printf '%s\n' '<testsuite name="sentry-probe"/>' > "$run_dir/sentry-maestro-results.xml"
  cat > "$run_dir/sentry-trigger.txt" <<EOF
platform=$platform
candidate_build_id=$candidate_build_id
marker=fixture-$platform-marker
EOF
  cat > "$run_dir/sentry-source-map-evidence.json" <<EOF
{"status":"PASS","eventId":"0123456789abcdef0123456789abcdef","platform":"$platform","candidateBuildId":"$candidate_build_id","marker":"fixture-$platform-marker","release":"chat-app@fixture","dist":"fixture","readableFrame":{"filename":"artifacts/chat-app/lib/sentry.ts","function":"createNativeSourceMapProbeError","line":55,"column":10},"storageRecovery":{"eventId":"fedcba9876543210fedcba9876543210","message":"Room key persistence retry failed","operation":"save"}}
EOF
  for index in $(seq 1 11); do
    printf 'fixture-%s-%s\n' "$platform" "$index" > "$run_dir/screenshots/screen-$index.png"
  done
  for index in 1 2; do
    printf 'fixture-call-%s-%s\n' "$platform" "$index" > "$run_dir/call-surface/call-$index.png"
  done
}

if [[ "$hostile_success_metadata" == "1" ]]; then
  write_success_evidence ios
  write_success_evidence android
fi

checker_env=("GITHUB_STEP_SUMMARY=$summary_path")
if [[ "$hostile_metadata" == "1" || "$hostile_success_metadata" == "1" ]]; then
  if [[ "$hostile_success_metadata" == "1" ]]; then
    ios_download_result="$(decode_probe 'c3VjY2Vzcw==')"
    android_download_result="$(decode_probe 'c3VjY2Vzcw==')"
    ios_artifact_url="$(
      decode_probe 'aHR0cHM6Ly9naXRodWIuZXhhbXBsZS9leGFtcGxlL2NoYXQtYXBwL2FjdGlvbnMvcnVucy8xMjMvYXJ0aWZhY3RzLzQ1NildKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpCjo6ZXJyb3I6OiQodG91Y2ggIl9fU0hFTExfTUFSS0VSX18iKQ=='
    )"
    android_artifact_url="$(
      decode_probe 'aHR0cHM6Ly9hdHRhY2tlci5leGFtcGxlL3JlcG9ydC5tZCldKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpO2VjaG8gYW5kcm9pZAo6Ondhcm5pbmc6OiQodG91Y2ggIl9fU0hFTExfTUFSS0VSX18iKQ=='
    )"
  else
    ios_download_result="$(
      decode_probe 'ZmFpbHVyZTsgdG91Y2ggIl9fU0hFTExfTUFSS0VSX18iIFtpT1NdKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9pb3MpCjo6ZXJyb3I6Omlvcw=='
    )"
    android_download_result="$(
      decode_probe 'JCh0b3VjaCAiX19TSEVMTF9NQVJLRVJfXyIpIFtBbmRyb2lkXShodHRwczovL2F0dGFja2VyLmV4YW1wbGUvYW5kcm9pZCkKYDo6d2FybmluZzo6YA=='
    )"
    ios_artifact_url="$(
      decode_probe 'aHR0cHM6Ly9naXRodWIuZXhhbXBsZS9leGFtcGxlL2NoYXQtYXBwL2FjdGlvbnMvcnVucy8xMjMvYXJ0aWZhY3RzLzQ1NildKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpCjo6ZXJyb3I6OiQodG91Y2ggIl9fU0hFTExfTUFSS0VSX18iKQ=='
    )"
    android_artifact_url="$(
      decode_probe 'aHR0cHM6Ly9hdHRhY2tlci5leGFtcGxlL3JlcG9ydC5tZCldKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpO2VjaG8gYW5kcm9pZA=='
    )"
  fi
  ios_download_result="${ios_download_result//__SHELL_MARKER__/$shell_marker_path}"
  android_download_result="${android_download_result//__SHELL_MARKER__/$shell_marker_path}"
  ios_artifact_url="${ios_artifact_url//__SHELL_MARKER__/$shell_marker_path}"
  android_artifact_url="${android_artifact_url//__SHELL_MARKER__/$shell_marker_path}"
  checker_env+=(
    "NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=$ios_download_result"
    "NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT=$android_download_result"
    "NATIVE_IOS_EVIDENCE_ARTIFACT_URL=$ios_artifact_url"
    "NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL=$android_artifact_url"
  )
fi

if env "${checker_env[@]}" bash "$root_dir/scripts/run-untrusted-checker.sh" "$@" "$blocked_root" \
  >"$checker_stdout" 2>"$checker_stderr"; then
  if [[ "$hostile_success_metadata" != "1" ]]; then
    echo "The blocked native evidence scenario unexpectedly passed." >&2
    exit 1
  fi
else
  if [[ "$hostile_success_metadata" == "1" ]]; then
    echo "The successful native evidence scenario unexpectedly failed." >&2
    exit 1
  fi
fi

ios_section="$(
  awk '
    /^## iOS native large-text evidence$/ { collecting=1 }
    /^## Android native large-text evidence$/ { collecting=0 }
    collecting { print }
  ' "$summary_path"
)"
android_section="$(
  awk '
    /^## Android native large-text evidence$/ { collecting=1 }
    collecting { print }
  ' "$summary_path"
)"

require_contains() {
  local section="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" <<< "$section"; then
    echo "Expected hosted summary to contain: $expected" >&2
    exit 1
  fi
}

require_not_contains() {
  local section="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" <<< "$section"; then
    echo "Hosted summary contained cross-platform detail: $unexpected" >&2
    exit 1
  fi
}

require_missing_result_finding() {
  local section="$1"
  local expected="$2"
  local findings
  findings="$(
    awk '
      /^### Blocking evidence findings$/ { collecting=1; next }
      /^### / { collecting=0 }
      collecting && /^- `/ { print }
    ' <<< "$section"
  )"
  if ! grep -Fq -- "$expected" <<< "$findings"; then
    echo "Expected the platform-specific missing result finding." >&2
    exit 1
  fi
}

if [[ "$hostile_success_metadata" == "1" ]]; then
  require_contains "$ios_section" "- Status: **PASS**"
  require_contains "$ios_section" "- Artifact download: **PASS**"
  require_contains "$ios_section" "- Detailed evidence report: **Unavailable**"
  require_contains "$android_section" "- Status: **PASS**"
  require_contains "$android_section" "- Artifact download: **PASS**"
  require_contains "$android_section" "- Detailed evidence report: **Unavailable**"
  require_not_contains "$ios_section" "- Detailed evidence report: ["
  require_not_contains "$android_section" "- Detailed evidence report: ["
else
  require_contains "$ios_section" "- Status: **FAIL**"
  require_contains "$ios_section" "- Validated run directory: **Unavailable**"
  require_contains "$ios_section" "- Detailed evidence report: **Unavailable**"
  require_not_contains "$ios_section" "$blocked_root/android"

  require_contains "$android_section" "- Status: **FAIL**"
  require_contains "$android_section" "- Validated run directory: **Unavailable**"
  require_contains "$android_section" "- Detailed evidence report: **Unavailable**"
  require_not_contains "$android_section" "$blocked_root/ios"
fi

if [[ "$hostile_metadata" == "1" ]]; then
  require_contains "$ios_section" "- Artifact download: **FAIL**"
  require_contains "$ios_section" "- Recovery: **Rerun the iOS native large-text job, or make the existing iOS artifact available, then rerun the mobile release gate.**"
  require_missing_result_finding "$ios_section" "- \`Missing result directory: $blocked_root/ios. Run the ios native large-text gate and upload its timestamped result directory.\`"
  require_contains "$android_section" "- Artifact download: **FAIL**"
  require_contains "$android_section" "- Recovery: **Rerun the Android native large-text job, or make the existing Android artifact available, then rerun the mobile release gate.**"
  require_missing_result_finding "$android_section" "- \`Missing result directory: $blocked_root/android. Run the android native large-text gate and upload its timestamped result directory.\`"
fi

require_file_contains() {
  local path="$1"
  local expected="$2"
  local label="$3"
  if ! grep -Fq -- "$expected" "$path"; then
    echo "Expected $label." >&2
    exit 1
  fi
}

require_file_not_contains_probe() {
  local path="$1"
  local label="$2"
  if grep -Fq -- "$shell_marker_path" "$path" ||
    grep -Fq -- "attacker.example" "$path" ||
    grep -Fq -- "::error::" "$path" ||
    grep -Fq -- "::warning::" "$path"; then
    echo "$label contained unsafe shell or Markdown probe text." >&2
    exit 1
  fi
}

stop_line="$(head -n 1 "$checker_stdout")"
resume_line="$(tail -n 1 "$checker_stdout")"
if [[ "$hostile_metadata" == "1" || "$hostile_success_metadata" == "1" ]] &&
  { [[ ! "$stop_line" =~ ^::stop-commands::([0-9a-f-]+)$ ]] ||
    [[ "$resume_line" != "::${BASH_REMATCH[1]}::" ]]; }; then
  echo "The checker output was not enclosed by a matching workflow command guard." >&2
  exit 1
fi

if [[ "$hostile_metadata" == "1" || "$hostile_success_metadata" == "1" ]]; then
  require_file_contains "$checker_stdout" \
    "Checking native large-text evidence under " \
    "the fixed checker stdout context"
  if [[ "$hostile_metadata" == "1" ]]; then
    require_file_contains "$checker_stderr" \
      "[ios] The iOS native evidence artifact download did not complete." \
      "the fixed iOS download failure context"
    require_file_contains "$checker_stderr" \
      "[android] The Android native evidence artifact download did not complete." \
      "the fixed Android download failure context"
    require_file_contains "$checker_stderr" \
      "Native large-text evidence completeness check FAILED with " \
      "the fixed native evidence failure context"
    require_file_contains "$checker_stderr" \
      "Release review is blocked until both platform evidence sets contain complete, non-empty reviewed device artifacts." \
      "the fixed release-blocking context"
  else
    require_file_contains "$checker_stdout" \
      "Native large-text evidence completeness check passed for iOS and Android." \
      "the fixed native evidence success context"
  fi
  require_file_not_contains_probe "$checker_stdout" "Checker stdout"
  require_file_not_contains_probe "$checker_stderr" "Checker stderr"
  require_file_not_contains_probe "$summary_path" "Generated summary"

  if [[ -e "$shell_marker_path" ]]; then
    echo "The hostile download metadata was evaluated as a shell command." >&2
    exit 1
  fi
fi

cat "$checker_stdout"
cat "$checker_stderr" >&2
if [[ -n "$summary_capture_path" ]]; then
  # Capture only the trusted revision block and the checker summary after all
  # assertions pass. Checker stdout/stderr are intentionally never copied.
  cat "$GITHUB_STEP_SUMMARY" "$summary_path" > "$summary_capture_path"
fi
cat "$summary_path" >> "$GITHUB_STEP_SUMMARY"
