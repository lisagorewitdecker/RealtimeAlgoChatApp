#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRITER="$ROOT_DIR/artifacts/chat-app/e2e/native-large-text/write-review-record-template.sh"
TEST_PARENT="$(mktemp -d)"
TEST_ROOT="$TEST_PARENT/fixtures"
CLEANUP_GUARD="$TEST_PARENT/cleanup-must-not-escape-fixtures"
mkdir -p "$TEST_ROOT"
printf 'keep\n' >"$CLEANUP_GUARD"

cleanup_test_fixtures() {
  rm -rf "$TEST_ROOT"
  if [[ ! -f "$CLEANUP_GUARD" ]]; then
    echo "Review-record template test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$TEST_PARENT"
}

trap cleanup_test_fixtures EXIT

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
# Keep notes=... for an optional one-line summary, or use this block for detailed findings.
notes<<END_NOTES
<optional multi-line findings; headings, bullets, links, and backticks are stored literally>
END_NOTES
EOF

  if ! cmp -s "$expected" "$actual"; then
    echo "Review-record template did not match for $platform:" >&2
    diff -u "$expected" "$actual" >&2 || true
    exit 1
  fi
done

cleanup_test_fixtures
trap - EXIT

echo "Native review-record template contract tests passed."