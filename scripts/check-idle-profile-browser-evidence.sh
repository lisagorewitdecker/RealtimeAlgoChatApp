#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo "Usage: $0 DOWNLOADED_ARTIFACT_DIRECTORY" >&2
  exit 2
fi

artifact_root="$1"
if [[ ! -d "$artifact_root" ]]; then
  echo "Downloaded idle-profile browser evidence directory is missing." >&2
  exit 1
fi

mapfile -t result_directories < <(
  find "$artifact_root" -mindepth 1 -maxdepth 1 -type d -print | sort
)
if ((${#result_directories[@]} != 1)); then
  echo "Expected exactly one Playwright result directory in the browser evidence artifact." >&2
  printf 'Found result directories: %s\n' "${#result_directories[@]}" >&2
  exit 1
fi

result_directory="${result_directories[0]}"
mapfile -t members < <(
  find "$result_directory" -mindepth 1 -type f -printf '%P\n' | sort
)
expected_members=(
  "error-context.md"
  "test-failed-1.png"
  "trace.zip"
)

if ((${#members[@]} != ${#expected_members[@]})); then
  echo "Idle-profile browser evidence archive does not contain exactly the expected members." >&2
  printf 'Expected members:\n%s\n' "${expected_members[*]}" >&2
  printf 'Actual members:\n%s\n' "${members[*]:-(none)}" >&2
  exit 1
fi

for index in "${!expected_members[@]}"; do
  if [[ "${members[$index]}" != "${expected_members[$index]}" ]]; then
    echo "Idle-profile browser evidence archive members changed." >&2
    printf 'Expected members:\n%s\n' "${expected_members[*]}" >&2
    printf 'Actual members:\n%s\n' "${members[*]}" >&2
    exit 1
  fi
done

for member in "${expected_members[@]}"; do
  member_path="$result_directory/$member"
  if [[ ! -s "$member_path" ]]; then
    echo "Idle-profile browser evidence member is missing or empty: $member" >&2
    exit 1
  fi
done

png_signature="$(od -An -tx1 -N8 "$result_directory/test-failed-1.png" | tr -d '[:space:]')"
if [[ "$png_signature" != "89504e470d0a1a0a" ]]; then
  echo "Idle-profile browser screenshot is not a PNG." >&2
  exit 1
fi

if ! unzip -tq "$result_directory/trace.zip" >/dev/null; then
  echo "Idle-profile browser trace is not a readable ZIP archive." >&2
  exit 1
fi

printf 'Idle-profile browser evidence contract passed: %s, %s, and %s.\n' \
  "test-failed-1.png" \
  "trace.zip" \
  "error-context.md"