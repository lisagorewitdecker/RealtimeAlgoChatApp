#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: bash scripts/archive-native-release-report.sh PLATFORM RESULTS_ROOT OUTPUT_PATH" >&2
  exit 2
fi

PLATFORM="$1"
RESULTS_ROOT="$2"
OUTPUT_PATH="$3"

case "$PLATFORM" in
  ios|android) ;;
  *)
    echo "Unsupported native release report platform." >&2
    exit 2
    ;;
esac

platform_root="$RESULTS_ROOT/$PLATFORM"
if [[ ! -d "$platform_root" ]]; then
  echo "Native release report source directory is unavailable." >&2
  exit 1
fi

mapfile -d '' run_dirs < <(
  find "$platform_root" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z
)
if [[ "${#run_dirs[@]}" -ne 1 ]]; then
  echo "Native release report archive requires exactly one validated run directory." >&2
  exit 1
fi

run_dir="${run_dirs[0]}"
report_path="$run_dir/native-branding-check.md"
candidate_path="$run_dir/candidate-build-id.txt"
if [[ ! -s "$report_path" || ! -s "$candidate_path" ]]; then
  echo "Native release report archive is missing its branding report or candidate boundary." >&2
  exit 1
fi

# The durable archive is deliberately a report, not a copy of the native
# artifact. Candidate IDs, runner paths, screenshots, account information,
# and credentials remain inside the bounded GitHub artifact. Keep this
# allowlist narrow so a future report field cannot silently widen the archive.
tmp_path="${OUTPUT_PATH}.tmp"
mkdir -p "$(dirname "$OUTPUT_PATH")"
{
  echo "# Native release evidence archive"
  echo
  printf -- "- Platform: **%s**\n" "$PLATFORM"
  echo
  awk '
    /^- Platform: / ||
    /^- Status: / ||
    /^- Approved product name: / ||
    /^- Native label: / ||
    /^- Camera permission copy: / ||
    /^- Microphone permission copy: / ||
    /^- Declared camera\/microphone permissions: / {
      print
    }
  ' "$report_path"
  echo
  echo "Sensitive source fields are intentionally excluded from this durable archive."
} > "$tmp_path"

if grep -Eiq 'candidate[ _-]*(build|id)|fingerprint|password|passwd|token|secret|authorization|bearer|credential|@[^ ]+\.[^ ]+' "$tmp_path"; then
  rm -f -- "$tmp_path"
  echo "Native release report archive failed its privacy boundary." >&2
  exit 1
fi

mv -- "$tmp_path" "$OUTPUT_PATH"
echo "Prepared redacted native release report archive."