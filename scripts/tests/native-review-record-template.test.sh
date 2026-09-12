#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRITER="$ROOT_DIR/artifacts/chat-app/e2e/native-large-text/write-review-record-template.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

for platform in ios android; do
  build_id="candidate-${platform}-exact-value"
  actual="$TEST_ROOT/$platform-review-record.template.txt"
  expected="$TEST_ROOT/$platform-expected.txt"

  bash "$WRITER" "$actual" "$platform" "$build_id"

  cat > "$expected" <<EOF
# After reviewing this run, replace every placeholder and rename this file to review-record.txt.
platform=$platform
reviewer=<full name or handle>
reviewed_at_utc=<output of: date -u +%Y-%m-%dT%H:%M:%SZ>
candidate_build_id=$build_id
decision=<APPROVED or REJECTED>
notes=<optional one-line summary of platform-specific findings>
EOF

  if ! cmp -s "$expected" "$actual"; then
    echo "Review-record template did not match for $platform:" >&2
    diff -u "$expected" "$actual" >&2 || true
    exit 1
  fi
done

echo "Native review-record template contract tests passed."