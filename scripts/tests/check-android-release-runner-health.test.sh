#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CHECKER="$WORKSPACE_ROOT/scripts/check-android-release-runner-health.sh"
BASH_BIN="$(command -v bash)"
ENV_BIN="$(command -v env)"
MKTEMP_BIN="$(command -v mktemp)"
GREP_BIN="$(command -v grep)"
MKDIR_BIN="$(command -v mkdir)"
RM_BIN="$(command -v rm)"

test_parent="$("$MKTEMP_BIN" -d)"
trap '"$RM_BIN" -rf "$test_parent"' EXIT
stub_bin="$test_parent/bin"
"$MKDIR_BIN" -p "$stub_bin"

cat >"$stub_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${GH_STUB_FAILURE:-0}" == "1" ]]; then
  echo "token must never be printed: ${GH_TOKEN:-}" >&2
  exit 1
fi
printf '%s\n' "${GH_STUB_JSON:?GH_STUB_JSON is required}"
EOF
chmod +x "$stub_bin/gh"

assert_contains() {
  local output="$1"
  local expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

run_case() {
  local name="$1"
  local expected_status="$2"
  local fixture="$3"
  local output status
  if output="$("$ENV_BIN" \
    PATH="$stub_bin:$PATH" \
    GITHUB_REPOSITORY=example/project \
    GITHUB_SHA=release-sha \
    GITHUB_STEP_SUMMARY="$test_parent/$name-summary.md" \
    GH_TOKEN=registration-secret-must-not-print \
    GH_STUB_JSON="$fixture" \
    "$BASH_BIN" "$CHECKER" 2>&1
  )"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name"
  printf '%s\n' "$output"
}

ready_fixture='[{"runners":[{"name":"android-release-linux","status":"online","labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"android"},{"name":"smallest-simulator"}]},{"name":"old-android-runner","status":"offline","labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"android"},{"name":"smallest-simulator"}]}]}]'
ready_output="$(run_case ready 0 "$ready_fixture")"
assert_contains "$ready_output" "ANDROID_RELEASE_RUNNER_HEALTH=READY"
assert_contains "$ready_output" 'Online runner with all required labels: `android-release-linux`'
assert_contains "$ready_output" 'old-android-runner`: offline; required labels present but runner is not online'
assert_contains "$(<"$test_parent/ready-summary.md")" "Operator procedure:"
assert_not_contains "$ready_output" "registration-secret-must-not-print"

missing_token_output="$(
  if "$ENV_BIN" \
    PATH="$stub_bin:$PATH" \
    GITHUB_REPOSITORY=example/project \
    GH_STUB_JSON="$ready_fixture" \
    "$BASH_BIN" "$CHECKER" 2>&1; then
    exit 1
  else
    status=$?
    [[ "$status" -eq 2 ]]
  fi
)"
assert_contains "$missing_token_output" \
  "GITHUB_WORKFLOW_PULL_TOKEN_FINAL must be configured with Administration: read access."

empty_token_output="$(
  if "$ENV_BIN" \
    PATH="$stub_bin:$PATH" \
    GITHUB_REPOSITORY=example/project \
    GH_TOKEN= \
    GH_STUB_JSON="$ready_fixture" \
    "$BASH_BIN" "$CHECKER" 2>&1; then
    exit 1
  else
    status=$?
    [[ "$status" -eq 2 ]]
  fi
)"
assert_contains "$empty_token_output" \
  "GITHUB_WORKFLOW_PULL_TOKEN_FINAL must be configured with Administration: read access."

missing_label_fixture='[{"runners":[{"name":"android-release-linux","status":"online","labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"android"}]}]}]'
missing_label_output="$(run_case missing-label 2 "$missing_label_fixture")"
assert_contains "$missing_label_output" "ANDROID_RELEASE_RUNNER_HEALTH=BLOCKED"
assert_contains "$missing_label_output" 'missing labels: smallest-simulator'

offline_fixture='[{"runners":[{"name":"android-release-linux","status":"offline","labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"android"},{"name":"smallest-simulator"}]}]}]'
offline_output="$(run_case offline 2 "$offline_fixture")"
assert_contains "$offline_output" "No online repository runner has all required labels"
assert_contains "$offline_output" 'android-release-linux`: offline; required labels present but runner is not online'

failure_output="$(
  if "$ENV_BIN" \
    PATH="$stub_bin:$PATH" \
    GITHUB_REPOSITORY=example/project \
    GH_TOKEN=registration-secret-must-not-print \
    GH_STUB_FAILURE=1 \
    "$BASH_BIN" "$CHECKER" 2>&1; then
    exit 1
  else
    status=$?
    [[ "$status" -eq 2 ]]
  fi
)"
assert_contains "$failure_output" "Could not query the repository self-hosted runner inventory."
assert_not_contains "$failure_output" "registration-secret-must-not-print"

echo "Android release runner health checks passed."