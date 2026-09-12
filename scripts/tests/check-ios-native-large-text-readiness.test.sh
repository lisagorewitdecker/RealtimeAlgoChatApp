#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
GATE_RELATIVE_PATH="artifacts/chat-app/e2e/native-large-text/run.sh"
GATE="$WORKSPACE_ROOT/$GATE_RELATIVE_PATH"
TEMPLATE_WRITER_RELATIVE_PATH="artifacts/chat-app/e2e/native-large-text/write-review-record-template.sh"
TEMPLATE_WRITER="$WORKSPACE_ROOT/$TEMPLATE_WRITER_RELATIVE_PATH"
WORKFLOW="$WORKSPACE_ROOT/.github/workflows/mobile-release.yml"
BASH_BIN="$(command -v bash)"
CP_BIN="$(command -v cp)"
ENV_BIN="$(command -v env)"
LN_BIN="$(command -v ln)"
MKTEMP_BIN="$(command -v mktemp)"
MKDIR_BIN="$(command -v mkdir)"
RM_BIN="$(command -v rm)"
GREP_BIN="$(command -v grep)"

test_root="$("$MKTEMP_BIN" -d)"
trap '"$RM_BIN" -rf "$test_root"' EXIT

utilities="$test_root/utilities"
"$MKDIR_BIN" -p "$utilities" "$test_root/home"
for command in cat date dirname find head mkdir sed tr wc; do
  "$LN_BIN" -s "$(command -v "$command")" "$utilities/$command"
done

SMALLEST_DEVICE="iPhone SE (3rd generation)"
SMALLEST_DEVICE_UDID="00000000-0000-0000-0000-000000000000"
SMALLEST_DEVICE_BOOTED="$SMALLEST_DEVICE ($SMALLEST_DEVICE_UDID) (Booted)"
LARGER_DEVICE="iPhone 14"
LARGER_DEVICE_UDID="11111111-1111-1111-1111-111111111111"
LARGER_DEVICE_BOOTED="$LARGER_DEVICE ($LARGER_DEVICE_UDID) (Booted)"

make_stub() {
  local path="$1"
  local name="$2"
  cat >"$path/$name" <<EOF
#!${BASH_BIN}
exit 0
EOF
  chmod +x "$path/$name"
}

make_command_path() {
  local name="$1"
  local path="$test_root/$name"
  "$MKDIR_BIN" -p "$path"
  for utility in "$utilities"/*; do
    "$LN_BIN" -s "$utility" "$path/$(basename "$utility")"
  done
  cat >"$path/maestro" <<EOF
#!${BASH_BIN}
printf 'maestro args: %s\n' "\$*"
exit 0
EOF
  chmod +x "$path/maestro"
  make_stub "$path" pnpm
  printf '%s\n' "$path"
}

make_xcrun_stub() {
  local path="$1"
  local booted_devices="$2"
  {
    printf '#!%s\n' "$BASH_BIN"
    printf 'printf "%%s\\n" %q\n' "$booted_devices"
  } >"$path/xcrun"
  chmod +x "$path/xcrun"
}

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
  local description="${3:-text}"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain %s: %s\n%s\n' \
      "$description" "$unexpected" "$output" >&2
    exit 1
  fi
}

assert_file_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then
    printf 'Expected no file at: %s\n' "$path" >&2
    exit 1
  fi
}

workflow_step() {
  local step_name="$1"
  sed -n \
    "/^[[:space:]]*- name: ${step_name}$/,/^[[:space:]]*- name: /p" \
    "$WORKFLOW"
}

assert_workflow_device_handoff() {
  local step_name="$1"
  local step
  step="$(workflow_step "$step_name")"
  assert_contains "$step" 'NATIVE_SMOKE_IOS_DEVICE_UDID: ${{ env.NATIVE_SMOKE_IOS_DEVICE_UDID }}'
}

summary_of() {
  cat "$test_root/$1-summary.md"
}

result_file_of() {
  cat "$test_root/$1-results/$2"
}

# The release workflow must export the verified iPhone SE UDID and explicitly
# pass that same value to both native consumers. This static contract runs on
# Linux and catches workflow drift without requiring Xcode or booted simulators.
ios_simulator_step="$(workflow_step "Verify prepared iPhone SE simulator")"
assert_contains \
  "$ios_simulator_step" \
  'printf '"'"'NATIVE_SMOKE_IOS_DEVICE_UDID=%s\n'"'"' "$device_udid" >> "$GITHUB_ENV"'
assert_workflow_device_handoff "Inspect installed iOS native branding"
assert_workflow_device_handoff "Run iOS native large-text release gate"

# Runs the gate for one case. Optional globals:
# - RUN_CASE_GATE: alternate gate path (defaults to the workspace gate).
# - RUN_CASE_DEFAULT_RESULTS_DIR=1: omit NATIVE_SMOKE_RESULTS_DIR so the gate
#   chooses its own results directory.
run_case() {
  local name="$1"
  local expected_status="$2"
  local path="$3"
  shift 3
  local gate="${RUN_CASE_GATE:-$GATE}"
  local output status
  local case_env=(
    PATH="$path:$utilities"
    HOME="$test_root/home"
    NATIVE_SMOKE_APP_ID=app-id-secret-sentinel
    NATIVE_SMOKE_BUILD_ID=build-id-secret-sentinel
    NATIVE_SMOKE_EMAIL=email-secret-sentinel
    NATIVE_SMOKE_PASSWORD=password-secret-sentinel
    GITHUB_STEP_SUMMARY="$test_root/$name-summary.md"
  )
  if [[ "${RUN_CASE_DEFAULT_RESULTS_DIR:-0}" != "1" ]]; then
    case_env+=(NATIVE_SMOKE_RESULTS_DIR="$test_root/$name-results")
  fi

  if output="$("$ENV_BIN" -i "${case_env[@]}" "$@" "$BASH_BIN" "$gate" ios 2>&1)"; then
    status=0
  else
    status=$?
  fi

  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' \
      "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name"
  printf '%s\n' "$output"

  for sentinel in \
    app-id-secret-sentinel \
    build-id-secret-sentinel \
    email-secret-sentinel \
    password-secret-sentinel; do
    assert_not_contains "$output" "$sentinel" "credential sentinel"
  done
}

missing_maestro_path="$(make_command_path missing-maestro)"
rm "$missing_maestro_path/maestro"
missing_maestro_output="$(
  run_case missing-maestro 2 "$missing_maestro_path"
)"
assert_contains "$missing_maestro_output" "Required command not found: maestro"
assert_contains "$(summary_of missing-maestro)" "Status: **BLOCKED**"
assert_contains "$(summary_of missing-maestro)" "Required command not found: maestro"

missing_xcrun_path="$(make_command_path missing-xcrun)"
missing_xcrun_output="$(
  run_case missing-xcrun 2 "$missing_xcrun_path"
)"
assert_contains "$missing_xcrun_output" "xcrun is required for the iOS smoke test."
assert_contains "$(summary_of missing-xcrun)" "Xcode simulator tooling: **BLOCKED**"

unavailable_simulator_path="$(make_command_path unavailable-simulator)"
make_xcrun_stub "$unavailable_simulator_path" ""
unavailable_simulator_output="$(
  run_case unavailable-simulator 2 "$unavailable_simulator_path"
)"
assert_contains \
  "$unavailable_simulator_output" \
  "Boot the smallest supported iOS simulator (iPhone SE, 3rd generation) first."
assert_contains \
  "$(summary_of unavailable-simulator)" \
  "No booted iPhone SE (3rd generation) simulator was found."

# Strict release path: the smallest supported simulator is a release-gate run
# and carries no diagnostic labels anywhere.
supported_model_path="$(make_command_path supported-model)"
make_xcrun_stub "$supported_model_path" "$SMALLEST_DEVICE_BOOTED"
supported_model_output="$(
  run_case supported-model 1 "$supported_model_path"
)"
assert_contains \
  "$supported_model_output" \
  "Running ios native large-text smoke test; artifacts:"
assert_contains \
  "$supported_model_output" \
  "Expected at least 11 native screenshots, found 0."
assert_not_contains "$supported_model_output" "DIAGNOSTIC-ONLY" "diagnostic label"
assert_contains "$(summary_of supported-model)" "## iOS native large-text readiness"
assert_contains "$(summary_of supported-model)" "Status: **READY**"
assert_contains "$(summary_of supported-model)" "Run mode: **RELEASE GATE**"
assert_contains \
  "$(summary_of supported-model)" \
  "Booted iPhone SE (3rd generation): **READY**"
assert_not_contains "$(summary_of supported-model)" "DIAGNOSTIC-ONLY" "diagnostic label"
assert_not_contains "$(summary_of supported-model)" "OVERRIDDEN" "override label"
assert_contains "$(result_file_of supported-model pass-fail-record.txt)" "run_mode=release-gate"
assert_contains "$(result_file_of supported-model runner-metadata.txt)" "run_mode=release-gate"
assert_contains \
  "$(result_file_of supported-model runner-metadata.txt)" \
  "device=iPhone SE (3rd generation)"
assert_contains \
  "$(result_file_of supported-model runner-metadata.txt)" \
  "device_udid=$SMALLEST_DEVICE_UDID"

# The exact SE is selected even when another booted simulator appears first.
multiple_booted_path="$(make_command_path multiple-booted)"
make_xcrun_stub "$multiple_booted_path" "$LARGER_DEVICE_BOOTED
$SMALLEST_DEVICE_BOOTED"
multiple_booted_output="$(
  run_case multiple-booted 1 "$multiple_booted_path"
)"
assert_contains \
  "$multiple_booted_output" \
  "Expected at least 11 native screenshots, found 0."
assert_contains \
  "$multiple_booted_output" \
  "maestro args: --device $SMALLEST_DEVICE_UDID test"
assert_contains \
  "$(summary_of multiple-booted)" \
  "Booted iPhone SE (3rd generation): **READY**"
assert_contains \
  "$(result_file_of multiple-booted runner-metadata.txt)" \
  "device_udid=$SMALLEST_DEVICE_UDID"

# Strict release path: a larger simulator is refused without the override.
wrong_model_path="$(make_command_path wrong-model)"
make_xcrun_stub "$wrong_model_path" "$LARGER_DEVICE_BOOTED"
wrong_model_output="$(
  run_case wrong-model 2 "$wrong_model_path"
)"
assert_contains \
  "$wrong_model_output" \
  "Expected a booted iPhone SE simulator, found: iPhone 14"
assert_contains \
  "$wrong_model_output" \
  "Set NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 only for a local, non-release diagnostic run."
assert_contains "$(summary_of wrong-model)" "Status: **BLOCKED**"
assert_contains "$(summary_of wrong-model)" "Run mode: **RELEASE GATE**"
assert_contains \
  "$(summary_of wrong-model)" \
  "Expected iPhone SE (3rd generation); found: iPhone 14"
assert_not_contains "$(summary_of wrong-model)" "OVERRIDDEN" "override label"
assert_file_absent "$test_root/wrong-model-results/runner-metadata.txt"
assert_contains "$(result_file_of wrong-model pass-fail-record.txt)" "status=FAIL"
assert_contains "$(result_file_of wrong-model pass-fail-record.txt)" "run_mode=release-gate"

# Local diagnostic override: the larger simulator is accepted, but every report
# labels the run diagnostic-only and never claims the iPhone SE was used.
diagnostic_override_path="$(make_command_path diagnostic-override)"
make_xcrun_stub "$diagnostic_override_path" "$LARGER_DEVICE_BOOTED"
diagnostic_override_output="$(
  run_case diagnostic-override 1 "$diagnostic_override_path" \
    NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1
)"
assert_contains \
  "$diagnostic_override_output" \
  "DIAGNOSTIC-ONLY RUN: NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is set. This output is not release evidence."
assert_contains \
  "$diagnostic_override_output" \
  "DIAGNOSTIC-ONLY RUN: the override accepted a larger simulator (iPhone 14); release evidence requires a booted iPhone SE (3rd generation)."
assert_contains \
  "$diagnostic_override_output" \
  "Running ios native large-text DIAGNOSTIC-ONLY smoke test (not release evidence); artifacts:"
assert_contains \
  "$diagnostic_override_output" \
  "Expected at least 11 native screenshots, found 0."
assert_not_contains \
  "$diagnostic_override_output" \
  "Expected a booted iPhone SE simulator" \
  "release-path refusal"
diagnostic_override_summary="$(summary_of diagnostic-override)"
assert_contains \
  "$diagnostic_override_summary" \
  "## iOS native large-text readiness (DIAGNOSTIC-ONLY)"
assert_contains "$diagnostic_override_summary" "Status: **READY**"
assert_contains \
  "$diagnostic_override_summary" \
  "Run mode: **DIAGNOSTIC-ONLY** (not release evidence)"
assert_contains \
  "$diagnostic_override_summary" \
  "Booted iPhone SE (3rd generation): **OVERRIDDEN** (diagnostic-only override accepted iPhone 14)"
assert_not_contains \
  "$diagnostic_override_summary" \
  "Booted iPhone SE (3rd generation): **READY**" \
  "false smallest-device claim"
assert_contains "$diagnostic_override_summary" "### Diagnostic-only run"
assert_contains \
  "$diagnostic_override_summary" \
  "must not be used as release evidence"
assert_contains \
  "$diagnostic_override_summary" \
  "The override accepted a larger simulator: iPhone 14."
assert_contains \
  "$diagnostic_override_summary" \
  "Unset NATIVE_SMOKE_ALLOW_LARGER_DEVICE and re-run on a booted iPhone SE (3rd generation) to produce release evidence."
assert_contains \
  "$(result_file_of diagnostic-override pass-fail-record.txt)" \
  "run_mode=diagnostic-only"
assert_contains \
  "$(result_file_of diagnostic-override runner-metadata.txt)" \
  "run_mode=diagnostic-only"
assert_contains \
  "$(result_file_of diagnostic-override runner-metadata.txt)" \
  "device=iPhone 14"
assert_contains \
  "$(result_file_of diagnostic-override runner-metadata.txt)" \
  "device_udid=$LARGER_DEVICE_UDID"

# The override marks the run diagnostic-only even when the smallest supported
# simulator happens to be booted.
diagnostic_supported_path="$(make_command_path diagnostic-supported-model)"
make_xcrun_stub "$diagnostic_supported_path" "$SMALLEST_DEVICE_BOOTED"
diagnostic_supported_output="$(
  run_case diagnostic-supported-model 1 "$diagnostic_supported_path" \
    NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1
)"
assert_contains \
  "$diagnostic_supported_output" \
  "DIAGNOSTIC-ONLY RUN: NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is set. This output is not release evidence."
diagnostic_supported_summary="$(summary_of diagnostic-supported-model)"
assert_contains \
  "$diagnostic_supported_summary" \
  "## iOS native large-text readiness (DIAGNOSTIC-ONLY)"
assert_contains \
  "$diagnostic_supported_summary" \
  "Run mode: **DIAGNOSTIC-ONLY** (not release evidence)"
assert_contains \
  "$diagnostic_supported_summary" \
  "Booted iPhone SE (3rd generation): **READY**"
assert_not_contains \
  "$diagnostic_supported_summary" \
  "The override accepted a larger simulator" \
  "larger-simulator note"
assert_contains \
  "$(result_file_of diagnostic-supported-model pass-fail-record.txt)" \
  "run_mode=diagnostic-only"
assert_contains \
  "$(result_file_of diagnostic-supported-model runner-metadata.txt)" \
  "run_mode=diagnostic-only"

# Release workflow runs refuse the override outright, whatever is booted.
workflow_override_path="$(make_command_path workflow-override)"
make_xcrun_stub "$workflow_override_path" "$LARGER_DEVICE_BOOTED"
workflow_override_output="$(
  run_case workflow-override 2 "$workflow_override_path" \
    GITHUB_ACTIONS=true \
    NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1
)"
assert_contains \
  "$workflow_override_output" \
  "NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is not permitted in release workflow runs; it is a local diagnostic-only override."
assert_not_contains "$workflow_override_output" "DIAGNOSTIC-ONLY RUN" "diagnostic banner"
assert_not_contains "$workflow_override_output" "Running ios native large-text" "smoke start"
workflow_override_summary="$(summary_of workflow-override)"
assert_contains "$workflow_override_summary" "## iOS native large-text readiness"
assert_contains "$workflow_override_summary" "Status: **BLOCKED**"
assert_contains "$workflow_override_summary" "Run mode: **RELEASE GATE**"
assert_contains "$workflow_override_summary" "### Blocking prerequisites"
assert_contains \
  "$workflow_override_summary" \
  "NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is not permitted in release workflow runs. Unset it on the runner; release evidence requires a booted iPhone SE (3rd generation) without the override."
assert_not_contains "$workflow_override_summary" "DIAGNOSTIC-ONLY" "diagnostic label"
assert_not_contains "$workflow_override_summary" "OVERRIDDEN" "override label"
assert_file_absent "$test_root/workflow-override-results/runner-metadata.txt"
assert_contains "$(result_file_of workflow-override pass-fail-record.txt)" "status=FAIL"
assert_contains "$(result_file_of workflow-override pass-fail-record.txt)" "run_mode=release-gate"

workflow_override_supported_path="$(make_command_path workflow-override-supported-model)"
make_xcrun_stub "$workflow_override_supported_path" "$SMALLEST_DEVICE_BOOTED"
workflow_override_supported_output="$(
  run_case workflow-override-supported-model 2 "$workflow_override_supported_path" \
    GITHUB_ACTIONS=true \
    NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1
)"
assert_contains \
  "$workflow_override_supported_output" \
  "NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is not permitted in release workflow runs; it is a local diagnostic-only override."
assert_contains "$(summary_of workflow-override-supported-model)" "Status: **BLOCKED**"
assert_file_absent "$test_root/workflow-override-supported-model-results/runner-metadata.txt"

# Release workflow runs without the override keep the strict smallest-device gate.
workflow_wrong_model_path="$(make_command_path workflow-wrong-model)"
make_xcrun_stub "$workflow_wrong_model_path" "$LARGER_DEVICE_BOOTED"
workflow_wrong_model_output="$(
  run_case workflow-wrong-model 2 "$workflow_wrong_model_path" \
    GITHUB_ACTIONS=true
)"
assert_contains \
  "$workflow_wrong_model_output" \
  "Expected a booted iPhone SE simulator, found: iPhone 14"
assert_contains "$(summary_of workflow-wrong-model)" "Status: **BLOCKED**"
assert_contains "$(summary_of workflow-wrong-model)" "Run mode: **RELEASE GATE**"
assert_contains \
  "$(summary_of workflow-wrong-model)" \
  "Expected iPhone SE (3rd generation); found: iPhone 14"

# Without NATIVE_SMOKE_RESULTS_DIR, diagnostic-only output lands in its own
# tree instead of the release evidence directory.
default_tree="$test_root/default-tree"
"$MKDIR_BIN" -p "$(dirname "$default_tree/$GATE_RELATIVE_PATH")"
"$CP_BIN" "$GATE" "$default_tree/$GATE_RELATIVE_PATH"
"$CP_BIN" "$TEMPLATE_WRITER" "$default_tree/$TEMPLATE_WRITER_RELATIVE_PATH"
default_diagnostic_path="$(make_command_path default-diagnostic)"
make_xcrun_stub "$default_diagnostic_path" "$LARGER_DEVICE_BOOTED"
RUN_CASE_GATE="$default_tree/$GATE_RELATIVE_PATH"
RUN_CASE_DEFAULT_RESULTS_DIR=1
default_diagnostic_output="$(
  run_case default-diagnostic 1 "$default_diagnostic_path" \
    NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1
)"
assert_contains \
  "$default_diagnostic_output" \
  "artifacts: $default_tree/test-results/native-large-text-diagnostic/ios/"
assert_file_absent "$default_tree/test-results/native-large-text"
default_diagnostic_readiness="$(cat "$default_tree"/test-results/native-large-text-diagnostic/ios/*/ios-readiness.md)"
assert_contains \
  "$default_diagnostic_readiness" \
  "## iOS native large-text readiness (DIAGNOSTIC-ONLY)"

default_release_path="$(make_command_path default-release)"
make_xcrun_stub "$default_release_path" "$SMALLEST_DEVICE_BOOTED"
default_release_output="$(
  run_case default-release 1 "$default_release_path"
)"
assert_contains \
  "$default_release_output" \
  "artifacts: $default_tree/test-results/native-large-text/ios/"
default_release_readiness="$(cat "$default_tree"/test-results/native-large-text/ios/*/ios-readiness.md)"
assert_contains "$default_release_readiness" "Run mode: **RELEASE GATE**"
assert_not_contains "$default_release_readiness" "DIAGNOSTIC-ONLY" "diagnostic label"
unset RUN_CASE_GATE RUN_CASE_DEFAULT_RESULTS_DIR

for summary in "$test_root"/*-summary.md; do
  for sentinel in \
    app-id-secret-sentinel \
    build-id-secret-sentinel \
    email-secret-sentinel \
    password-secret-sentinel; do
    assert_not_contains "$(<"$summary")" "$sentinel" "credential sentinel"
  done
done

echo "iOS native large-text readiness regression tests passed."
