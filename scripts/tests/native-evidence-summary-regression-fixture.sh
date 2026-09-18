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

: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY to the job summary file.}"
: "${REVIEWED_REF:?Set REVIEWED_REF to the checked ref.}"

if [[ "$hostile_metadata" != "0" && "$hostile_metadata" != "1" ]]; then
  echo "NATIVE_EVIDENCE_HOSTILE_METADATA must be 0 or 1." >&2
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

checker_env=("GITHUB_STEP_SUMMARY=$summary_path")
if [[ "$hostile_metadata" == "1" ]]; then
  ios_download_result="$(
    decode_probe 'ZmFpbHVyZTsgdG91Y2ggIl9fU0hFTExfTUFSS0VSX18iIFtpT1NdKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9pb3MpCjo6ZXJyb3I6Omlvcw=='
  )"
  ios_download_result="${ios_download_result//__SHELL_MARKER__/$shell_marker_path}"
  android_download_result="$(
    decode_probe 'JCh0b3VjaCAiX19TSEVMTF9NQVJLRVJfXyIpIFtBbmRyb2lkXShodHRwczovL2F0dGFja2VyLmV4YW1wbGUvYW5kcm9pZCkKYDo6d2FybmluZzo6YA=='
  )"
  android_download_result="${android_download_result//__SHELL_MARKER__/$shell_marker_path}"
  ios_artifact_url="$(
    decode_probe 'aHR0cHM6Ly9naXRodWIuZXhhbXBsZS9leGFtcGxlL2NoYXQtYXBwL2FjdGlvbnMvcnVucy8xMjMvYXJ0aWZhY3RzLzQ1NildKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpCjo6ZXJyb3I6OiQodG91Y2ggIl9fU0hFTExfTUFSS0VSX18iKQ=='
  )"
  ios_artifact_url="${ios_artifact_url//__SHELL_MARKER__/$shell_marker_path}"
  android_artifact_url="$(
    decode_probe 'aHR0cHM6Ly9hdHRhY2tlci5leGFtcGxlL3JlcG9ydC5tZCldKGh0dHBzOi8vYXR0YWNrZXIuZXhhbXBsZS9zZWNvbmQpO2VjaG8gYW5kcm9pZA=='
  )"
  checker_env+=(
    "NATIVE_IOS_EVIDENCE_DOWNLOAD_RESULT=$ios_download_result"
    "NATIVE_ANDROID_EVIDENCE_DOWNLOAD_RESULT=$android_download_result"
    "NATIVE_IOS_EVIDENCE_ARTIFACT_URL=$ios_artifact_url"
    "NATIVE_ANDROID_EVIDENCE_ARTIFACT_URL=$android_artifact_url"
  )
fi

if env "${checker_env[@]}" bash "$root_dir/scripts/run-untrusted-checker.sh" "$@" "$blocked_root" \
  >"$checker_stdout" 2>"$checker_stderr"; then
  echo "The blocked native evidence scenario unexpectedly passed." >&2
  exit 1
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

require_contains "$ios_section" "- Status: **FAIL**"
require_contains "$ios_section" "- Validated run directory: **Unavailable**"
require_contains "$ios_section" "- Detailed evidence report: **Unavailable**"
require_not_contains "$ios_section" "$blocked_root/android"

require_contains "$android_section" "- Status: **FAIL**"
require_contains "$android_section" "- Validated run directory: **Unavailable**"
require_contains "$android_section" "- Detailed evidence report: **Unavailable**"
require_not_contains "$android_section" "$blocked_root/ios"

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
if [[ "$hostile_metadata" == "1" ]] &&
  { [[ ! "$stop_line" =~ ^::stop-commands::([0-9a-f-]+)$ ]] ||
    [[ "$resume_line" != "::${BASH_REMATCH[1]}::" ]]; }; then
  echo "The checker output was not enclosed by a matching workflow command guard." >&2
  exit 1
fi

if [[ "$hostile_metadata" == "1" ]]; then
  require_file_contains "$checker_stdout" \
    "Checking native large-text evidence under " \
    "the fixed checker stdout context"
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
cat "$summary_path" >> "$GITHUB_STEP_SUMMARY"
