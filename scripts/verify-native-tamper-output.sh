#!/usr/bin/env bash
set -euo pipefail

if (($# != 2)); then
  echo "Usage: $0 CHECKER_LOG SUMMARY_PATH" >&2
  exit 2
fi

checker_log="$1"
summary_path="$2"

if [[ ! -s "$checker_log" ]]; then
  echo "Hosted tamper regression produced no captured checker log." >&2
  exit 1
fi
if [[ ! -f "$summary_path" ]]; then
  echo "Hosted tamper regression summary is unavailable." >&2
  exit 1
fi

if ! grep -Eq -- '^::stop-commands::[0-9a-f-]+$' "$checker_log"; then
  echo "Hosted tamper regression log is missing its workflow-command stop marker." >&2
  exit 1
fi
stop_token="$(sed -n '1s/^::stop-commands:://p' "$checker_log")"
if [[ "$(tail -n 1 "$checker_log")" != "::${stop_token}::" ]]; then
  echo "Hosted tamper regression log is missing its matching workflow-command resume marker." >&2
  exit 1
fi
stop_marker_count="$(grep -Fc -- '::stop-commands::' "$checker_log" || true)"
if [[ "$stop_marker_count" != "1" ]]; then
  echo "Hosted tamper regression log contains an unexpected workflow-command stop marker." >&2
  exit 1
fi
resume_marker_count="$(grep -Fxc -- "::${stop_token}::" "$checker_log" || true)"
if [[ "$resume_marker_count" != "1" ]]; then
  echo "Hosted tamper regression log contains an unexpected workflow-command resume marker." >&2
  exit 1
fi

for output_path in "$checker_log" "$summary_path"; do
  if grep -Eiq -- '::(error|warning|notice|set-output|save-state|add-mask)([[:space:]]|:)' "$output_path" ||
    { [[ "$output_path" == "$checker_log" ]] &&
      sed '1d;$d' "$output_path" | grep -Eq -- '^::[^:]+::'; } ||
    { [[ "$output_path" == "$summary_path" ]] &&
      grep -Eq -- '^::[^:]+::' "$output_path"; }; then
    echo "Hosted tamper regression exposed an untrusted workflow command in its output." >&2
    exit 1
  fi
  for encoded_marker in \
    Y2FuZGlkYXRlLWlvcy1wcml2YXRlLXNlbnRpbmVs \
    Y2FuZGlkYXRlLWFuZHJvaWQtcHJpdmF0ZS1zZW50aW5lbA== \
    cmV2aWV3ZXItaW9zLXByaXZhdGUtc2VudGluZWw= \
    cmV2aWV3ZXItYW5kcm9pZC1wcml2YXRlLXNlbnRpbmVs; do
    private_marker="$(printf '%s' "$encoded_marker" | base64 --decode)"
    if grep -Fq -- "$private_marker" "$output_path"; then
      echo "Hosted tamper regression exposed a private fixture sentinel in its output." >&2
      exit 1
    fi
  done
done

# Only a fully validated stream may become reviewer-visible. The wrapper's
# matching stop/resume pair is retained so checker output remains inert.
cat "$checker_log"