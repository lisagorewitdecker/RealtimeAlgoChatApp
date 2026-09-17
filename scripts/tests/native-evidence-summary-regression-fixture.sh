#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 CHECKER_COMMAND [ARG...]" >&2
  exit 2
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
blocked_root="$(mktemp -d)"
summary_path="$(mktemp)"
trap 'rm -rf "$blocked_root" "$summary_path"' EXIT
resolved_commit_sha="$(git -C "$root_dir" rev-parse --verify HEAD)"

: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY to the job summary file.}"
: "${REVIEWED_REF:?Set REVIEWED_REF to the checked ref.}"

{
  echo "## Reviewed release revision"
  printf -- '- Checked ref: `%s`\n' "$REVIEWED_REF"
  printf -- '- Resolved commit SHA: `%s`\n' "$resolved_commit_sha"
} >> "$GITHUB_STEP_SUMMARY"

if GITHUB_STEP_SUMMARY="$summary_path" bash \
  "$root_dir/scripts/run-untrusted-checker.sh" "$@" "$blocked_root"; then
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

require_only_missing_result_finding() {
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
  if [[ "$findings" != "$expected" ]]; then
    printf 'Expected exactly one platform-specific blocking finding:\n%s\n' "$findings" >&2
    exit 1
  fi
}

require_contains "$ios_section" "- Status: **FAIL**"
require_contains "$ios_section" "- Validated run directory: **Unavailable**"
require_contains "$ios_section" "- Detailed evidence report: **Unavailable**"
require_only_missing_result_finding "$ios_section" "- \`Missing result directory: $blocked_root/ios. Run the ios native large-text gate and upload its timestamped result directory.\`"
require_not_contains "$ios_section" "$blocked_root/android"

require_contains "$android_section" "- Status: **FAIL**"
require_contains "$android_section" "- Validated run directory: **Unavailable**"
require_contains "$android_section" "- Detailed evidence report: **Unavailable**"
require_only_missing_result_finding "$android_section" "- \`Missing result directory: $blocked_root/android. Run the android native large-text gate and upload its timestamped result directory.\`"
require_not_contains "$android_section" "$blocked_root/ios"

cat "$summary_path" >> "$GITHUB_STEP_SUMMARY"