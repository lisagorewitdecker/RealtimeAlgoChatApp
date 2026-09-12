#!/usr/bin/env bash
set -euo pipefail

OUTPUT_PATH="${1:?output path is required}"
PLATFORM="${2:?platform is required}"
CANDIDATE_BUILD_ID="${3:?candidate build ID is required}"

cat > "$OUTPUT_PATH" <<EOF
# After reviewing this run, replace every placeholder and rename this file to review-record.txt.
platform=$PLATFORM
reviewer=<full name or handle>
reviewed_at_utc=<output of: date -u +%Y-%m-%dT%H:%M:%SZ>
candidate_build_id=$CANDIDATE_BUILD_ID
decision=<APPROVED or REJECTED>
notes=<optional one-line summary of platform-specific findings>
EOF