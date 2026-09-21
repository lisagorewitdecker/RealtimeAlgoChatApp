#!/usr/bin/env bash
#
# Exercises scripts/check-ios-runner-dry-run-report.sh, the verdict the
# GitHub-hosted macOS job applies to a real `provision-ios-runner.sh --dry-run`
# transcript. The transcripts come from the real script driven through
# simulated-macOS stubs (uname reporting Darwin, xcrun listings padded with
# trailing whitespace), so the checker is tested against the report format the
# script actually prints. PROVISION_TEST_BASH runs both scripts under another
# bash build (for example bash 3.2.57, the version macOS ships); the hosted
# job runs this suite under /bin/bash.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROVISION="$WORKSPACE_ROOT/scripts/provision-ios-runner.sh"
CHECKER="$WORKSPACE_ROOT/scripts/check-ios-runner-dry-run-report.sh"
CONTRACT="$WORKSPACE_ROOT/scripts/ios-runner-contract.sh"
BASH_BIN="${PROVISION_TEST_BASH:-$(command -v bash)}"
[[ -x "$BASH_BIN" ]] || { printf 'PROVISION_TEST_BASH is not an executable bash: %s\n' "$BASH_BIN" >&2; exit 1; }
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"

test_parent="$(mktemp -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
mkdir -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  rm -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "iOS runner dry-run report check test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output="$1" expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1" unexpected="$2"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

source "$CONTRACT"
"$BASH_BIN" -n "$CHECKER" || fail "Bash 3.2 syntax check failed for $CHECKER"

# ---------------------------------------------------------------------------
# Simulated macOS in an isolated PATH: the real script's full dry run, with
# the Xcode tooling answered by stubs. XCRUN_RUNTIMES_UNPARSABLE breaks the
# runtime listing's layout and XCRUN_NO_SE_TYPE withdraws the device type.
# ---------------------------------------------------------------------------

utilities="$test_root/utilities"
mkdir -p "$utilities"
for command in sed head tail tr cat mkdir mktemp rm id sort grep find sleep date wc awk; do
  resolved="$(command -v "$command" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || fail "the test host lacks '$command', which the isolated PATH needs"
  ln -s "$resolved" "$utilities/$command"
done

macos_stubs="$test_root/macos-stubs"
mkdir -p "$macos_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "arm64\\n"; else printf "Darwin\\n"; fi\n' "$BASH_BIN" >"$macos_stubs/uname"
printf '#!%s\nprintf "15.6\\n"\n' "$BASH_BIN" >"$macos_stubs/sw_vers"
printf '#!%s\nprintf "/Applications/Xcode.app/Contents/Developer\\n"\n' "$BASH_BIN" >"$macos_stubs/xcode-select"
# A brew stub keeps the dry run away from a real Homebrew (the hosted Mac has
# one at /opt/homebrew/bin/brew, which the script also probes by path).
cat >"$macos_stubs/brew" <<EOF
#!${BASH_BIN}
case "\${1:-}" in
  shellenv) ;;
  --prefix) printf '/opt/homebrew\\n' ;;
  *) printf 'unexpected brew call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
cat >"$macos_stubs/xcrun" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$XCRUN_LOG"
case "\$*" in
  "simctl list devices") ;;
  "simctl list runtimes available")
    printf '== Runtimes ==\\n'
    if [[ -n "\${XCRUN_RUNTIMES_UNPARSABLE:-}" ]]; then
      printf 'iOS 26.0 (26.0 - 23A339) com.apple.CoreSimulator.SimRuntime.iOS-26-0\\n'
    else
      printf 'iOS 26.0 (26.0 - 23A339) - com.apple.CoreSimulator.SimRuntime.iOS-26-0 \\n'
    fi
    printf 'watchOS 26.0 (26.0 - 23R356) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0 \\n'
    ;;
  "simctl list devices available")
    printf '== Devices ==\\n-- iOS 26.0 --\\n'
    printf '    iPhone 17 (11111111-2222-3333-4444-555555555555) (Shutdown) \\n'
    if [[ -n "\${XCRUN_SE_STATE:-}" ]]; then
      printf '    %s (ABCDEF12-3456-7890-ABCD-EF1234567890) (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "\$XCRUN_SE_STATE"
    fi
    ;;
  "simctl list devicetypes")
    printf '== Device Types ==\\n'
    printf 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17) \\n'
    if [[ -z "\${XCRUN_NO_SE_TYPE:-}" ]]; then
      printf '%s (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "${IOS_RUNNER_SIMULATOR_DEVICE_TYPE}"
    fi
    ;;
  *) printf 'unexpected xcrun call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$macos_stubs"/*

# dry_run_transcript <name> <PATH> [VAR=value ...]: runs the real script's
# dry run non-interactively (stdin closed, no GitHub access, an empty runner
# root) and prints the transcript path.
dry_run_transcript() {
  local name="$1" path="$2"
  shift 2
  local home="$test_root/home-$name" transcript="$test_root/$name.log" status=0
  mkdir -p "$home"
  "$ENV_BIN" -i PATH="$path" HOME="$home" XCRUN_LOG="$test_root/xcrun-$name.log" \
    RUNNER_NAME=ios-release-mac RUNNER_ROOT="$test_root/runner-root-$name" "$@" \
    "$BASH_BIN" "$PROVISION" --dry-run --no-github </dev/null >"$transcript" 2>&1 || status=$?
  [[ "$status" -eq 0 ]] || fail "the $name dry run exited $status:
$(cat "$transcript")"
  if [[ -n "$(find "$home" -mindepth 1 -print -quit)" ]]; then
    fail "the $name dry run wrote under HOME: $(find "$home" -mindepth 1)"
  fi
  [[ ! -e "$test_root/runner-root-$name" ]] || fail "the $name dry run created the runner root"
  printf '%s\n' "$transcript"
}

# run_checker <name> <expected status> <transcript> [checker args ...]
run_checker() {
  local name="$1" expected_status="$2" transcript="$3"
  shift 3
  local output status=0
  output="$("$BASH_BIN" "$CHECKER" "$transcript" "$@" 2>&1)" || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

# ---------------------------------------------------------------------------
# A hosted Mac without the simulator: Xcode and the runtime are READY and the
# simulator row plans the creation, so the check passes and the summary
# quotes the report.
# ---------------------------------------------------------------------------

plan_transcript="$(dry_run_transcript planned-simulator "$macos_stubs:$utilities")"
assert_contains "$(cat "$plan_transcript")" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$(cat "$plan_transcript")" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$(cat "$plan_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$(cat "$plan_transcript")" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_contains "$(cat "$plan_transcript")" "| Homebrew | READY | ${macos_stubs}/brew |"
assert_not_contains "$(cat "$plan_transcript")" "unexpected brew call"
assert_not_contains "$(cat "$plan_transcript")" "unexpected xcrun call"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl create"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl boot"

plan_summary="$test_root/summary-planned.md"
printf 'existing summary content\n' >"$plan_summary"
plan_output="$(run_checker planned-simulator-passes 0 "$plan_transcript" --summary "$plan_summary")"
assert_contains "$plan_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
assert_contains "$plan_output" "Xcode with simctl: READY: /Applications/Xcode.app/Contents/Developer"
assert_contains "$plan_output" "iOS simulator runtime: READY: com.apple.CoreSimulator.SimRuntime.iOS-26-0"
assert_contains "$plan_output" "Booted ${IOS_RUNNER_SIMULATOR_NAME}: MISSING: will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted"
assert_not_contains "$plan_output" "finding:"
[[ "$(printf '%s\n' "$plan_output" | tail -n 1)" == "IOS_RUNNER_DRY_RUN_CHECK=PASS" ]] ||
  fail "the verdict must be the last line of the checker output"
plan_summary_text="$(cat "$plan_summary")"
assert_contains "$plan_summary_text" "existing summary content"
assert_contains "$plan_summary_text" "## iOS runner setup script on a GitHub-hosted Mac"
assert_contains "$plan_summary_text" "- Result: **PASS**"
assert_contains "$plan_summary_text" "### Readiness report (quoted from the dry run)"
assert_contains "$plan_summary_text" "## iOS release runner readiness"
assert_contains "$plan_summary_text" "- Mode: dry run (no changes were made)"
assert_contains "$plan_summary_text" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$plan_summary_text" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$plan_summary_text" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$plan_summary_text" "nothing was registered or installed"
assert_not_contains "$plan_summary_text" "Findings:"

# The same check passes without a summary file, and a booted simulator
# (READY with its UDID) passes too.
run_checker planned-simulator-passes-without-summary 0 "$plan_transcript" >/dev/null
booted_transcript="$(dry_run_transcript booted-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Booted)"
assert_contains "$(cat "$booted_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | READY | ABCDEF12-3456-7890-ABCD-EF1234567890 |"
booted_output="$(run_checker booted-simulator-passes 0 "$booted_transcript")"
assert_contains "$booted_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
shutdown_transcript="$(dry_run_transcript shutdown-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Shutdown)"
assert_contains "$(cat "$shutdown_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be booted (ABCDEF12-3456-7890-ABCD-EF1234567890) |"
shutdown_output="$(run_checker shutdown-simulator-passes 0 "$shutdown_transcript")"
assert_contains "$shutdown_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"

# ---------------------------------------------------------------------------
# Failures the hosted Mac must surface: an unparsed runtime listing, a device
# type the Xcode no longer offers, a Linux transcript, an unfinished run, a
# transcript without the report, and a non-dry-run report.
# ---------------------------------------------------------------------------

unparsed_transcript="$(dry_run_transcript unparsed-runtime "$macos_stubs:$utilities" XCRUN_RUNTIMES_UNPARSABLE=1)"
assert_contains "$(cat "$unparsed_transcript")" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"
unparsed_summary="$test_root/summary-unparsed.md"
unparsed_output="$(run_checker unparsed-runtime-fails 1 "$unparsed_transcript" --summary "$unparsed_summary")"
assert_contains "$unparsed_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$unparsed_output" "finding: iOS simulator runtime is MISSING on a hosted Mac (the runtime listing was not parsed, or the image lacks an iOS runtime): run: xcodebuild -downloadPlatform iOS"
assert_contains "$unparsed_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): will be created on an iOS runtime and booted"
assert_not_contains "$unparsed_output" "finding: Xcode with simctl"
unparsed_summary_text="$(cat "$unparsed_summary")"
assert_contains "$unparsed_summary_text" "- Result: **FAIL**"
assert_contains "$unparsed_summary_text" "- Findings:"
assert_contains "$unparsed_summary_text" "  - iOS simulator runtime is MISSING on a hosted Mac"
assert_contains "$unparsed_summary_text" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"

no_type_transcript="$(dry_run_transcript unavailable-device-type "$macos_stubs:$utilities" XCRUN_NO_SE_TYPE=1)"
assert_contains "$(cat "$no_type_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode; check 'xcrun simctl list devicetypes' |"
no_type_output="$(run_checker unavailable-device-type-fails 1 "$no_type_transcript")"
assert_contains "$no_type_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$no_type_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode"
assert_not_contains "$no_type_output" "finding: iOS simulator runtime"

linux_stubs="$test_root/linux-stubs"
mkdir -p "$linux_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n' "$BASH_BIN" >"$linux_stubs/uname"
chmod +x "$linux_stubs/uname"
linux_transcript="$(dry_run_transcript linux-host "$linux_stubs:$utilities")"
assert_contains "$(cat "$linux_transcript")" "| Xcode with simctl | SKIPPED |"
linux_output="$(run_checker linux-transcript-fails 1 "$linux_transcript")"
assert_contains "$linux_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$linux_output" "finding: the report was not produced on macOS (- Host: Linux (x86_64); dry run only, macOS-only checks skipped)"
assert_contains "$linux_output" "finding: Xcode with simctl is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: iOS simulator runtime is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is SKIPPED instead of READY or a planned MISSING"

unfinished_transcript="$test_root/unfinished.log"
grep -v '^IOS_RELEASE_RUNNER=' "$plan_transcript" >"$unfinished_transcript"
unfinished_output="$(run_checker unfinished-run-fails 1 "$unfinished_transcript")"
assert_contains "$unfinished_output" "finding: the dry run did not finish (no IOS_RELEASE_RUNNER= line after the report)"

truncated_transcript="$test_root/truncated.log"
head -n 12 "$plan_transcript" >"$truncated_transcript"
printf 'error: something stopped the dry run early\n' >>"$truncated_transcript"
truncated_summary="$test_root/summary-truncated.md"
truncated_output="$(run_checker missing-report-fails 1 "$truncated_transcript" --summary "$truncated_summary")"
assert_contains "$truncated_output" "finding: the transcript has no '## iOS release runner readiness' report; the dry run stopped before printing it"
assert_contains "$truncated_output" "Xcode with simctl: not reported"
truncated_summary_text="$(cat "$truncated_summary")"
assert_contains "$truncated_summary_text" "- Result: **FAIL**"
assert_contains "$truncated_summary_text" "### Dry-run transcript (last 40 lines; no readiness report was printed)"
assert_contains "$truncated_summary_text" "error: something stopped the dry run early"

not_dry_run_transcript="$test_root/not-dry-run.log"
grep -v '^- Mode: dry run' "$plan_transcript" >"$not_dry_run_transcript"
not_dry_run_output="$(run_checker non-dry-run-report-fails 1 "$not_dry_run_transcript")"
assert_contains "$not_dry_run_output" "finding: the report was not produced by a dry run (no '- Mode: dry run (no changes were made)' line)"

# ---------------------------------------------------------------------------
# Summary safety: quoted report text is sanitized at the workflow output
# boundary (workflow-command sentinels encoded, control characters replaced)
# and cannot close the fenced block early; long reports are bounded.
# ---------------------------------------------------------------------------

hostile_transcript="$test_root/hostile.log"
hostile_detail="/Applications/Xcode.app/Contents/Developer ::add-mask::hostile \`\`\`\`closing$(printf '\r')fence"
plan_text="$(cat "$plan_transcript")"
original_xcode_row="| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
hostile_xcode_row="| Xcode with simctl | READY | ${hostile_detail} |"
printf '%s\n' "${plan_text//"$original_xcode_row"/$hostile_xcode_row}" >"$hostile_transcript"
"$GREP_BIN" -Fq -- '::add-mask::hostile ````closing' "$hostile_transcript" || fail "the hostile fixture did not replace the Xcode row"
hostile_summary="$test_root/summary-hostile.md"
hostile_output="$(run_checker hostile-report-text-is-sanitized 0 "$hostile_transcript" --summary "$hostile_summary")"
assert_contains "$hostile_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
hostile_summary_text="$(cat "$hostile_summary")"
assert_not_contains "$hostile_summary_text" "::add-mask::"
assert_contains "$hostile_summary_text" "&#58;&#58;add-mask&#58;&#58;hostile"
if LC_ALL=C "$GREP_BIN" -q "$(printf '\r')" "$hostile_summary"; then
  fail "control characters must not reach the job summary"
fi
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````text$' "$hostile_summary")" == "1" ]] || fail "the fenced block must open with a fence longer than any backtick run in the quoted text"
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````$' "$hostile_summary")" == "1" ]] || fail "the fenced block must close with a fence longer than any backtick run in the quoted text"
if LC_ALL=C "$GREP_BIN" -q '^```text$' "$hostile_summary"; then
  fail "a three-backtick fence would be closed early by the quoted text"
fi
# A report without long backtick runs keeps the ordinary three-backtick fence.
[[ "$(LC_ALL=C "$GREP_BIN" -c '^```text$' "$plan_summary")" == "1" ]] || fail "an ordinary report must be fenced with three backticks"

long_transcript="$test_root/long.log"
{
  cat "$plan_transcript"
  index=0
  while ((index < 200)); do
    printf 'padding line %s after the report\n' "$index"
    index=$((index + 1))
  done
} >"$long_transcript"
long_summary="$test_root/summary-long.md"
run_checker long-report-is-bounded 0 "$long_transcript" --summary "$long_summary" >/dev/null
long_summary_text="$(cat "$long_summary")"
assert_contains "$long_summary_text" "(truncated to 120 lines and 16384 bytes)"
assert_not_contains "$long_summary_text" "padding line 199 after the report"
[[ "$(wc -l <"$long_summary" | tr -d ' ')" -lt 150 ]] || fail "the bounded summary is too long: $(wc -l <"$long_summary") lines"

# ---------------------------------------------------------------------------
# Usage errors exit 2 and never print a verdict.
# ---------------------------------------------------------------------------

usage_output="$("$BASH_BIN" "$CHECKER" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$usage_output" "the dry-run transcript path is required"
assert_contains "$usage_output" "exit=2"
assert_not_contains "$usage_output" "IOS_RUNNER_DRY_RUN_CHECK="
missing_output="$("$BASH_BIN" "$CHECKER" "$test_root/does-not-exist.log" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$missing_output" "transcript not found"
assert_contains "$missing_output" "exit=2"
summary_flag_output="$("$BASH_BIN" "$CHECKER" "$plan_transcript" --summary 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$summary_flag_output" "--summary needs a file path"
assert_contains "$summary_flag_output" "exit=2"
help_output="$("$BASH_BIN" "$CHECKER" --help)"
assert_contains "$help_output" "Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]"

cleanup_test_fixtures
trap - EXIT

printf 'check-ios-runner-dry-run-report.test.sh: all cases passed\n'
#!/usr/bin/env bash
#
# Exercises scripts/check-ios-runner-dry-run-report.sh, the verdict the
# GitHub-hosted macOS job applies to a real `provision-ios-runner.sh --dry-run`
# transcript. The transcripts come from the real script driven through
# simulated-macOS stubs (uname reporting Darwin, xcrun listings padded with
# trailing whitespace), so the checker is tested against the report format the
# script actually prints. PROVISION_TEST_BASH runs both scripts under another
# bash build (for example bash 3.2.57, the version macOS ships); the hosted
# job runs this suite under /bin/bash.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROVISION="$WORKSPACE_ROOT/scripts/provision-ios-runner.sh"
CHECKER="$WORKSPACE_ROOT/scripts/check-ios-runner-dry-run-report.sh"
CONTRACT="$WORKSPACE_ROOT/scripts/ios-runner-contract.sh"
BASH_BIN="${PROVISION_TEST_BASH:-$(command -v bash)}"
[[ -x "$BASH_BIN" ]] || { printf 'PROVISION_TEST_BASH is not an executable bash: %s\n' "$BASH_BIN" >&2; exit 1; }
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"

test_parent="$(mktemp -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
mkdir -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  rm -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "iOS runner dry-run report check test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output="$1" expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1" unexpected="$2"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

source "$CONTRACT"
"$BASH_BIN" -n "$CHECKER" || fail "Bash 3.2 syntax check failed for $CHECKER"

# ---------------------------------------------------------------------------
# Simulated macOS in an isolated PATH: the real script's full dry run, with
# the Xcode tooling answered by stubs. XCRUN_RUNTIMES_UNPARSABLE breaks the
# runtime listing's layout and XCRUN_NO_SE_TYPE withdraws the device type.
# ---------------------------------------------------------------------------

utilities="$test_root/utilities"
mkdir -p "$utilities"
for command in sed head tail tr cat mkdir mktemp rm id sort grep find sleep date wc awk; do
  resolved="$(command -v "$command" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || fail "the test host lacks '$command', which the isolated PATH needs"
  ln -s "$resolved" "$utilities/$command"
done

macos_stubs="$test_root/macos-stubs"
mkdir -p "$macos_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "arm64\\n"; else printf "Darwin\\n"; fi\n' "$BASH_BIN" >"$macos_stubs/uname"
printf '#!%s\nprintf "15.6\\n"\n' "$BASH_BIN" >"$macos_stubs/sw_vers"
printf '#!%s\nprintf "/Applications/Xcode.app/Contents/Developer\\n"\n' "$BASH_BIN" >"$macos_stubs/xcode-select"
# A brew stub keeps the dry run away from a real Homebrew (the hosted Mac has
# one at /opt/homebrew/bin/brew, which the script also probes by path).
cat >"$macos_stubs/brew" <<EOF
#!${BASH_BIN}
case "\${1:-}" in
  shellenv) ;;
  --prefix) printf '/opt/homebrew\\n' ;;
  *) printf 'unexpected brew call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
cat >"$macos_stubs/xcrun" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$XCRUN_LOG"
case "\$*" in
  "simctl list devices") ;;
  "simctl list runtimes available")
    printf '== Runtimes ==\\n'
    if [[ -n "\${XCRUN_RUNTIMES_UNPARSABLE:-}" ]]; then
      printf 'iOS 26.0 (26.0 - 23A339) com.apple.CoreSimulator.SimRuntime.iOS-26-0\\n'
    else
      printf 'iOS 26.0 (26.0 - 23A339) - com.apple.CoreSimulator.SimRuntime.iOS-26-0 \\n'
    fi
    printf 'watchOS 26.0 (26.0 - 23R356) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0 \\n'
    ;;
  "simctl list devices available")
    printf '== Devices ==\\n-- iOS 26.0 --\\n'
    printf '    iPhone 17 (11111111-2222-3333-4444-555555555555) (Shutdown) \\n'
    if [[ -n "\${XCRUN_SE_STATE:-}" ]]; then
      printf '    %s (ABCDEF12-3456-7890-ABCD-EF1234567890) (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "\$XCRUN_SE_STATE"
    fi
    ;;
  "simctl list devicetypes")
    printf '== Device Types ==\\n'
    printf 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17) \\n'
    if [[ -z "\${XCRUN_NO_SE_TYPE:-}" ]]; then
      printf '%s (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "${IOS_RUNNER_SIMULATOR_DEVICE_TYPE}"
    fi
    ;;
  *) printf 'unexpected xcrun call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$macos_stubs"/*

# dry_run_transcript <name> <PATH> [VAR=value ...]: runs the real script's
# dry run non-interactively (stdin closed, no GitHub access, an empty runner
# root) and prints the transcript path.
dry_run_transcript() {
  local name="$1" path="$2"
  shift 2
  local home="$test_root/home-$name" transcript="$test_root/$name.log" status=0
  mkdir -p "$home"
  "$ENV_BIN" -i PATH="$path" HOME="$home" XCRUN_LOG="$test_root/xcrun-$name.log" \
    RUNNER_NAME=ios-release-mac RUNNER_ROOT="$test_root/runner-root-$name" "$@" \
    "$BASH_BIN" "$PROVISION" --dry-run --no-github </dev/null >"$transcript" 2>&1 || status=$?
  [[ "$status" -eq 0 ]] || fail "the $name dry run exited $status:
$(cat "$transcript")"
  if [[ -n "$(find "$home" -mindepth 1 -print -quit)" ]]; then
    fail "the $name dry run wrote under HOME: $(find "$home" -mindepth 1)"
  fi
  [[ ! -e "$test_root/runner-root-$name" ]] || fail "the $name dry run created the runner root"
  printf '%s\n' "$transcript"
}

# run_checker <name> <expected status> <transcript> [checker args ...]
run_checker() {
  local name="$1" expected_status="$2" transcript="$3"
  shift 3
  local output status=0
  output="$("$BASH_BIN" "$CHECKER" "$transcript" "$@" 2>&1)" || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

# ---------------------------------------------------------------------------
# A hosted Mac without the simulator: Xcode and the runtime are READY and the
# simulator row plans the creation, so the check passes and the summary
# quotes the report.
# ---------------------------------------------------------------------------

plan_transcript="$(dry_run_transcript planned-simulator "$macos_stubs:$utilities")"
assert_contains "$(cat "$plan_transcript")" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$(cat "$plan_transcript")" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$(cat "$plan_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$(cat "$plan_transcript")" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_contains "$(cat "$plan_transcript")" "| Homebrew | READY | ${macos_stubs}/brew |"
assert_not_contains "$(cat "$plan_transcript")" "unexpected brew call"
assert_not_contains "$(cat "$plan_transcript")" "unexpected xcrun call"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl create"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl boot"

plan_summary="$test_root/summary-planned.md"
printf 'existing summary content\n' >"$plan_summary"
plan_output="$(run_checker planned-simulator-passes 0 "$plan_transcript" --summary "$plan_summary")"
assert_contains "$plan_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
assert_contains "$plan_output" "Xcode with simctl: READY: /Applications/Xcode.app/Contents/Developer"
assert_contains "$plan_output" "iOS simulator runtime: READY: com.apple.CoreSimulator.SimRuntime.iOS-26-0"
assert_contains "$plan_output" "Booted ${IOS_RUNNER_SIMULATOR_NAME}: MISSING: will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted"
assert_not_contains "$plan_output" "finding:"
[[ "$(printf '%s\n' "$plan_output" | tail -n 1)" == "IOS_RUNNER_DRY_RUN_CHECK=PASS" ]] ||
  fail "the verdict must be the last line of the checker output"
plan_summary_text="$(cat "$plan_summary")"
assert_contains "$plan_summary_text" "existing summary content"
assert_contains "$plan_summary_text" "## iOS runner setup script on a GitHub-hosted Mac"
assert_contains "$plan_summary_text" "- Result: **PASS**"
assert_contains "$plan_summary_text" "### Readiness report (quoted from the dry run)"
assert_contains "$plan_summary_text" "## iOS release runner readiness"
assert_contains "$plan_summary_text" "- Mode: dry run (no changes were made)"
assert_contains "$plan_summary_text" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$plan_summary_text" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$plan_summary_text" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$plan_summary_text" "nothing was registered or installed"
assert_not_contains "$plan_summary_text" "Findings:"

# The same check passes without a summary file, and a booted simulator
# (READY with its UDID) passes too.
run_checker planned-simulator-passes-without-summary 0 "$plan_transcript" >/dev/null
booted_transcript="$(dry_run_transcript booted-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Booted)"
assert_contains "$(cat "$booted_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | READY | ABCDEF12-3456-7890-ABCD-EF1234567890 |"
booted_output="$(run_checker booted-simulator-passes 0 "$booted_transcript")"
assert_contains "$booted_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
shutdown_transcript="$(dry_run_transcript shutdown-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Shutdown)"
assert_contains "$(cat "$shutdown_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be booted (ABCDEF12-3456-7890-ABCD-EF1234567890) |"
shutdown_output="$(run_checker shutdown-simulator-passes 0 "$shutdown_transcript")"
assert_contains "$shutdown_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"

# ---------------------------------------------------------------------------
# Failures the hosted Mac must surface: an unparsed runtime listing, a device
# type the Xcode no longer offers, a Linux transcript, an unfinished run, a
# transcript without the report, and a non-dry-run report.
# ---------------------------------------------------------------------------

unparsed_transcript="$(dry_run_transcript unparsed-runtime "$macos_stubs:$utilities" XCRUN_RUNTIMES_UNPARSABLE=1)"
assert_contains "$(cat "$unparsed_transcript")" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"
unparsed_summary="$test_root/summary-unparsed.md"
unparsed_output="$(run_checker unparsed-runtime-fails 1 "$unparsed_transcript" --summary "$unparsed_summary")"
assert_contains "$unparsed_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$unparsed_output" "finding: iOS simulator runtime is MISSING on a hosted Mac (the runtime listing was not parsed, or the image lacks an iOS runtime): run: xcodebuild -downloadPlatform iOS"
assert_contains "$unparsed_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): will be created on an iOS runtime and booted"
assert_not_contains "$unparsed_output" "finding: Xcode with simctl"
unparsed_summary_text="$(cat "$unparsed_summary")"
assert_contains "$unparsed_summary_text" "- Result: **FAIL**"
assert_contains "$unparsed_summary_text" "- Findings:"
assert_contains "$unparsed_summary_text" "  - iOS simulator runtime is MISSING on a hosted Mac"
assert_contains "$unparsed_summary_text" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"

no_type_transcript="$(dry_run_transcript unavailable-device-type "$macos_stubs:$utilities" XCRUN_NO_SE_TYPE=1)"
assert_contains "$(cat "$no_type_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode; check 'xcrun simctl list devicetypes' |"
no_type_output="$(run_checker unavailable-device-type-fails 1 "$no_type_transcript")"
assert_contains "$no_type_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$no_type_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode"
assert_not_contains "$no_type_output" "finding: iOS simulator runtime"

linux_stubs="$test_root/linux-stubs"
mkdir -p "$linux_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n' "$BASH_BIN" >"$linux_stubs/uname"
chmod +x "$linux_stubs/uname"
linux_transcript="$(dry_run_transcript linux-host "$linux_stubs:$utilities")"
assert_contains "$(cat "$linux_transcript")" "| Xcode with simctl | SKIPPED |"
linux_output="$(run_checker linux-transcript-fails 1 "$linux_transcript")"
assert_contains "$linux_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$linux_output" "finding: the report was not produced on macOS (- Host: Linux (x86_64); dry run only, macOS-only checks skipped)"
assert_contains "$linux_output" "finding: Xcode with simctl is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: iOS simulator runtime is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is SKIPPED instead of READY or a planned MISSING"

unfinished_transcript="$test_root/unfinished.log"
grep -v '^IOS_RELEASE_RUNNER=' "$plan_transcript" >"$unfinished_transcript"
unfinished_output="$(run_checker unfinished-run-fails 1 "$unfinished_transcript")"
assert_contains "$unfinished_output" "finding: the dry run did not finish (no IOS_RELEASE_RUNNER= line after the report)"

truncated_transcript="$test_root/truncated.log"
head -n 12 "$plan_transcript" >"$truncated_transcript"
printf 'error: something stopped the dry run early\n' >>"$truncated_transcript"
truncated_summary="$test_root/summary-truncated.md"
truncated_output="$(run_checker missing-report-fails 1 "$truncated_transcript" --summary "$truncated_summary")"
assert_contains "$truncated_output" "finding: the transcript has no '## iOS release runner readiness' report; the dry run stopped before printing it"
assert_contains "$truncated_output" "Xcode with simctl: not reported"
truncated_summary_text="$(cat "$truncated_summary")"
assert_contains "$truncated_summary_text" "- Result: **FAIL**"
assert_contains "$truncated_summary_text" "### Dry-run transcript (last 40 lines; no readiness report was printed)"
assert_contains "$truncated_summary_text" "error: something stopped the dry run early"

not_dry_run_transcript="$test_root/not-dry-run.log"
grep -v '^- Mode: dry run' "$plan_transcript" >"$not_dry_run_transcript"
not_dry_run_output="$(run_checker non-dry-run-report-fails 1 "$not_dry_run_transcript")"
assert_contains "$not_dry_run_output" "finding: the report was not produced by a dry run (no '- Mode: dry run (no changes were made)' line)"

# ---------------------------------------------------------------------------
# Summary safety: quoted report text is sanitized at the workflow output
# boundary (workflow-command sentinels encoded, control characters replaced)
# and cannot close the fenced block early; long reports are bounded.
# ---------------------------------------------------------------------------

hostile_transcript="$test_root/hostile.log"
hostile_detail="/Applications/Xcode.app/Contents/Developer ::add-mask::hostile \`\`\`\`closing$(printf '\r')fence"
plan_text="$(cat "$plan_transcript")"
original_xcode_row="| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
hostile_xcode_row="| Xcode with simctl | READY | ${hostile_detail} |"
printf '%s\n' "${plan_text//"$original_xcode_row"/$hostile_xcode_row}" >"$hostile_transcript"
"$GREP_BIN" -Fq -- '::add-mask::hostile ````closing' "$hostile_transcript" || fail "the hostile fixture did not replace the Xcode row"
hostile_summary="$test_root/summary-hostile.md"
hostile_output="$(run_checker hostile-report-text-is-sanitized 0 "$hostile_transcript" --summary "$hostile_summary")"
assert_contains "$hostile_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
hostile_summary_text="$(cat "$hostile_summary")"
assert_not_contains "$hostile_summary_text" "::add-mask::"
assert_contains "$hostile_summary_text" "&#58;&#58;add-mask&#58;&#58;hostile"
if LC_ALL=C "$GREP_BIN" -q "$(printf '\r')" "$hostile_summary"; then
  fail "control characters must not reach the job summary"
fi
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````text$' "$hostile_summary")" == "1" ]] || fail "the fenced block must open with a fence longer than any backtick run in the quoted text"
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````$' "$hostile_summary")" == "1" ]] || fail "the fenced block must close with a fence longer than any backtick run in the quoted text"
if LC_ALL=C "$GREP_BIN" -q '^```text$' "$hostile_summary"; then
  fail "a three-backtick fence would be closed early by the quoted text"
fi
# A report without long backtick runs keeps the ordinary three-backtick fence.
[[ "$(LC_ALL=C "$GREP_BIN" -c '^```text$' "$plan_summary")" == "1" ]] || fail "an ordinary report must be fenced with three backticks"

long_transcript="$test_root/long.log"
{
  cat "$plan_transcript"
  index=0
  while ((index < 200)); do
    printf 'padding line %s after the report\n' "$index"
    index=$((index + 1))
  done
} >"$long_transcript"
long_summary="$test_root/summary-long.md"
run_checker long-report-is-bounded 0 "$long_transcript" --summary "$long_summary" >/dev/null
long_summary_text="$(cat "$long_summary")"
assert_contains "$long_summary_text" "(truncated to 120 lines and 16384 bytes)"
assert_not_contains "$long_summary_text" "padding line 199 after the report"
[[ "$(wc -l <"$long_summary" | tr -d ' ')" -lt 150 ]] || fail "the bounded summary is too long: $(wc -l <"$long_summary") lines"

# ---------------------------------------------------------------------------
# Usage errors exit 2 and never print a verdict.
# ---------------------------------------------------------------------------

usage_output="$("$BASH_BIN" "$CHECKER" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$usage_output" "the dry-run transcript path is required"
assert_contains "$usage_output" "exit=2"
assert_not_contains "$usage_output" "IOS_RUNNER_DRY_RUN_CHECK="
missing_output="$("$BASH_BIN" "$CHECKER" "$test_root/does-not-exist.log" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$missing_output" "transcript not found"
assert_contains "$missing_output" "exit=2"
summary_flag_output="$("$BASH_BIN" "$CHECKER" "$plan_transcript" --summary 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$summary_flag_output" "--summary needs a file path"
assert_contains "$summary_flag_output" "exit=2"
help_output="$("$BASH_BIN" "$CHECKER" --help)"
assert_contains "$help_output" "Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]"

cleanup_test_fixtures
trap - EXIT

printf 'check-ios-runner-dry-run-report.test.sh: all cases passed\n'
#!/usr/bin/env bash
#
# Exercises scripts/check-ios-runner-dry-run-report.sh, the verdict the
# GitHub-hosted macOS job applies to a real `provision-ios-runner.sh --dry-run`
# transcript. The transcripts come from the real script driven through
# simulated-macOS stubs (uname reporting Darwin, xcrun listings padded with
# trailing whitespace), so the checker is tested against the report format the
# script actually prints. PROVISION_TEST_BASH runs both scripts under another
# bash build (for example bash 3.2.57, the version macOS ships); the hosted
# job runs this suite under /bin/bash.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROVISION="$WORKSPACE_ROOT/scripts/provision-ios-runner.sh"
CHECKER="$WORKSPACE_ROOT/scripts/check-ios-runner-dry-run-report.sh"
CONTRACT="$WORKSPACE_ROOT/scripts/ios-runner-contract.sh"
BASH_BIN="${PROVISION_TEST_BASH:-$(command -v bash)}"
[[ -x "$BASH_BIN" ]] || { printf 'PROVISION_TEST_BASH is not an executable bash: %s\n' "$BASH_BIN" >&2; exit 1; }
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"

test_parent="$(mktemp -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
mkdir -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  rm -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "iOS runner dry-run report check test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output="$1" expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1" unexpected="$2"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

source "$CONTRACT"
"$BASH_BIN" -n "$CHECKER" || fail "Bash 3.2 syntax check failed for $CHECKER"

# ---------------------------------------------------------------------------
# Simulated macOS in an isolated PATH: the real script's full dry run, with
# the Xcode tooling answered by stubs. XCRUN_RUNTIMES_UNPARSABLE breaks the
# runtime listing's layout and XCRUN_NO_SE_TYPE withdraws the device type.
# ---------------------------------------------------------------------------

utilities="$test_root/utilities"
mkdir -p "$utilities"
for command in sed head tail tr cat mkdir mktemp rm id sort grep find sleep date wc awk; do
  resolved="$(command -v "$command" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || fail "the test host lacks '$command', which the isolated PATH needs"
  ln -s "$resolved" "$utilities/$command"
done

macos_stubs="$test_root/macos-stubs"
mkdir -p "$macos_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "arm64\\n"; else printf "Darwin\\n"; fi\n' "$BASH_BIN" >"$macos_stubs/uname"
printf '#!%s\nprintf "15.6\\n"\n' "$BASH_BIN" >"$macos_stubs/sw_vers"
printf '#!%s\nprintf "/Applications/Xcode.app/Contents/Developer\\n"\n' "$BASH_BIN" >"$macos_stubs/xcode-select"
# A brew stub keeps the dry run away from a real Homebrew (the hosted Mac has
# one at /opt/homebrew/bin/brew, which the script also probes by path).
cat >"$macos_stubs/brew" <<EOF
#!${BASH_BIN}
case "\${1:-}" in
  shellenv) ;;
  --prefix) printf '/opt/homebrew\\n' ;;
  *) printf 'unexpected brew call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
cat >"$macos_stubs/xcrun" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$XCRUN_LOG"
case "\$*" in
  "simctl list devices") ;;
  "simctl list runtimes available")
    printf '== Runtimes ==\\n'
    if [[ -n "\${XCRUN_RUNTIMES_UNPARSABLE:-}" ]]; then
      printf 'iOS 26.0 (26.0 - 23A339) com.apple.CoreSimulator.SimRuntime.iOS-26-0\\n'
    else
      printf 'iOS 26.0 (26.0 - 23A339) - com.apple.CoreSimulator.SimRuntime.iOS-26-0 \\n'
    fi
    printf 'watchOS 26.0 (26.0 - 23R356) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0 \\n'
    ;;
  "simctl list devices available")
    printf '== Devices ==\\n-- iOS 26.0 --\\n'
    printf '    iPhone 17 (11111111-2222-3333-4444-555555555555) (Shutdown) \\n'
    if [[ -n "\${XCRUN_SE_STATE:-}" ]]; then
      printf '    %s (ABCDEF12-3456-7890-ABCD-EF1234567890) (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "\$XCRUN_SE_STATE"
    fi
    ;;
  "simctl list devicetypes")
    printf '== Device Types ==\\n'
    printf 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17) \\n'
    if [[ -z "\${XCRUN_NO_SE_TYPE:-}" ]]; then
      printf '%s (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "${IOS_RUNNER_SIMULATOR_DEVICE_TYPE}"
    fi
    ;;
  *) printf 'unexpected xcrun call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$macos_stubs"/*

# dry_run_transcript <name> <PATH> [VAR=value ...]: runs the real script's
# dry run non-interactively (stdin closed, no GitHub access, an empty runner
# root) and prints the transcript path.
dry_run_transcript() {
  local name="$1" path="$2"
  shift 2
  local home="$test_root/home-$name" transcript="$test_root/$name.log" status=0
  mkdir -p "$home"
  "$ENV_BIN" -i PATH="$path" HOME="$home" XCRUN_LOG="$test_root/xcrun-$name.log" \
    RUNNER_NAME=ios-release-mac RUNNER_ROOT="$test_root/runner-root-$name" "$@" \
    "$BASH_BIN" "$PROVISION" --dry-run --no-github </dev/null >"$transcript" 2>&1 || status=$?
  [[ "$status" -eq 0 ]] || fail "the $name dry run exited $status:
$(cat "$transcript")"
  if [[ -n "$(find "$home" -mindepth 1 -print -quit)" ]]; then
    fail "the $name dry run wrote under HOME: $(find "$home" -mindepth 1)"
  fi
  [[ ! -e "$test_root/runner-root-$name" ]] || fail "the $name dry run created the runner root"
  printf '%s\n' "$transcript"
}

# run_checker <name> <expected status> <transcript> [checker args ...]
run_checker() {
  local name="$1" expected_status="$2" transcript="$3"
  shift 3
  local output status=0
  output="$("$BASH_BIN" "$CHECKER" "$transcript" "$@" 2>&1)" || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

# ---------------------------------------------------------------------------
# A hosted Mac without the simulator: Xcode and the runtime are READY and the
# simulator row plans the creation, so the check passes and the summary
# quotes the report.
# ---------------------------------------------------------------------------

plan_transcript="$(dry_run_transcript planned-simulator "$macos_stubs:$utilities")"
assert_contains "$(cat "$plan_transcript")" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$(cat "$plan_transcript")" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$(cat "$plan_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$(cat "$plan_transcript")" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_contains "$(cat "$plan_transcript")" "| Homebrew | READY | ${macos_stubs}/brew |"
assert_not_contains "$(cat "$plan_transcript")" "unexpected brew call"
assert_not_contains "$(cat "$plan_transcript")" "unexpected xcrun call"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl create"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl boot"

plan_summary="$test_root/summary-planned.md"
printf 'existing summary content\n' >"$plan_summary"
plan_output="$(run_checker planned-simulator-passes 0 "$plan_transcript" --summary "$plan_summary")"
assert_contains "$plan_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
assert_contains "$plan_output" "Xcode with simctl: READY: /Applications/Xcode.app/Contents/Developer"
assert_contains "$plan_output" "iOS simulator runtime: READY: com.apple.CoreSimulator.SimRuntime.iOS-26-0"
assert_contains "$plan_output" "Booted ${IOS_RUNNER_SIMULATOR_NAME}: MISSING: will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted"
assert_not_contains "$plan_output" "finding:"
[[ "$(printf '%s\n' "$plan_output" | tail -n 1)" == "IOS_RUNNER_DRY_RUN_CHECK=PASS" ]] ||
  fail "the verdict must be the last line of the checker output"
plan_summary_text="$(cat "$plan_summary")"
assert_contains "$plan_summary_text" "existing summary content"
assert_contains "$plan_summary_text" "## iOS runner setup script on a GitHub-hosted Mac"
assert_contains "$plan_summary_text" "- Result: **PASS**"
assert_contains "$plan_summary_text" "### Readiness report (quoted from the dry run)"
assert_contains "$plan_summary_text" "## iOS release runner readiness"
assert_contains "$plan_summary_text" "- Mode: dry run (no changes were made)"
assert_contains "$plan_summary_text" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$plan_summary_text" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$plan_summary_text" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$plan_summary_text" "nothing was registered or installed"
assert_not_contains "$plan_summary_text" "Findings:"

# The same check passes without a summary file, and a booted simulator
# (READY with its UDID) passes too.
run_checker planned-simulator-passes-without-summary 0 "$plan_transcript" >/dev/null
booted_transcript="$(dry_run_transcript booted-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Booted)"
assert_contains "$(cat "$booted_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | READY | ABCDEF12-3456-7890-ABCD-EF1234567890 |"
booted_output="$(run_checker booted-simulator-passes 0 "$booted_transcript")"
assert_contains "$booted_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
shutdown_transcript="$(dry_run_transcript shutdown-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Shutdown)"
assert_contains "$(cat "$shutdown_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be booted (ABCDEF12-3456-7890-ABCD-EF1234567890) |"
shutdown_output="$(run_checker shutdown-simulator-passes 0 "$shutdown_transcript")"
assert_contains "$shutdown_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"

# ---------------------------------------------------------------------------
# Failures the hosted Mac must surface: an unparsed runtime listing, a device
# type the Xcode no longer offers, a Linux transcript, an unfinished run, a
# transcript without the report, and a non-dry-run report.
# ---------------------------------------------------------------------------

unparsed_transcript="$(dry_run_transcript unparsed-runtime "$macos_stubs:$utilities" XCRUN_RUNTIMES_UNPARSABLE=1)"
assert_contains "$(cat "$unparsed_transcript")" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"
unparsed_summary="$test_root/summary-unparsed.md"
unparsed_output="$(run_checker unparsed-runtime-fails 1 "$unparsed_transcript" --summary "$unparsed_summary")"
assert_contains "$unparsed_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$unparsed_output" "finding: iOS simulator runtime is MISSING on a hosted Mac (the runtime listing was not parsed, or the image lacks an iOS runtime): run: xcodebuild -downloadPlatform iOS"
assert_contains "$unparsed_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): will be created on an iOS runtime and booted"
assert_not_contains "$unparsed_output" "finding: Xcode with simctl"
unparsed_summary_text="$(cat "$unparsed_summary")"
assert_contains "$unparsed_summary_text" "- Result: **FAIL**"
assert_contains "$unparsed_summary_text" "- Findings:"
assert_contains "$unparsed_summary_text" "  - iOS simulator runtime is MISSING on a hosted Mac"
assert_contains "$unparsed_summary_text" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"

no_type_transcript="$(dry_run_transcript unavailable-device-type "$macos_stubs:$utilities" XCRUN_NO_SE_TYPE=1)"
assert_contains "$(cat "$no_type_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode; check 'xcrun simctl list devicetypes' |"
no_type_output="$(run_checker unavailable-device-type-fails 1 "$no_type_transcript")"
assert_contains "$no_type_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$no_type_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode"
assert_not_contains "$no_type_output" "finding: iOS simulator runtime"

linux_stubs="$test_root/linux-stubs"
mkdir -p "$linux_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n' "$BASH_BIN" >"$linux_stubs/uname"
chmod +x "$linux_stubs/uname"
linux_transcript="$(dry_run_transcript linux-host "$linux_stubs:$utilities")"
assert_contains "$(cat "$linux_transcript")" "| Xcode with simctl | SKIPPED |"
linux_output="$(run_checker linux-transcript-fails 1 "$linux_transcript")"
assert_contains "$linux_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$linux_output" "finding: the report was not produced on macOS (- Host: Linux (x86_64); dry run only, macOS-only checks skipped)"
assert_contains "$linux_output" "finding: Xcode with simctl is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: iOS simulator runtime is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is SKIPPED instead of READY or a planned MISSING"

unfinished_transcript="$test_root/unfinished.log"
grep -v '^IOS_RELEASE_RUNNER=' "$plan_transcript" >"$unfinished_transcript"
unfinished_output="$(run_checker unfinished-run-fails 1 "$unfinished_transcript")"
assert_contains "$unfinished_output" "finding: the dry run did not finish (no IOS_RELEASE_RUNNER= line after the report)"

truncated_transcript="$test_root/truncated.log"
head -n 12 "$plan_transcript" >"$truncated_transcript"
printf 'error: something stopped the dry run early\n' >>"$truncated_transcript"
truncated_summary="$test_root/summary-truncated.md"
truncated_output="$(run_checker missing-report-fails 1 "$truncated_transcript" --summary "$truncated_summary")"
assert_contains "$truncated_output" "finding: the transcript has no '## iOS release runner readiness' report; the dry run stopped before printing it"
assert_contains "$truncated_output" "Xcode with simctl: not reported"
truncated_summary_text="$(cat "$truncated_summary")"
assert_contains "$truncated_summary_text" "- Result: **FAIL**"
assert_contains "$truncated_summary_text" "### Dry-run transcript (last 40 lines; no readiness report was printed)"
assert_contains "$truncated_summary_text" "error: something stopped the dry run early"

not_dry_run_transcript="$test_root/not-dry-run.log"
grep -v '^- Mode: dry run' "$plan_transcript" >"$not_dry_run_transcript"
not_dry_run_output="$(run_checker non-dry-run-report-fails 1 "$not_dry_run_transcript")"
assert_contains "$not_dry_run_output" "finding: the report was not produced by a dry run (no '- Mode: dry run (no changes were made)' line)"

# ---------------------------------------------------------------------------
# Summary safety: quoted report text is sanitized at the workflow output
# boundary (workflow-command sentinels encoded, control characters replaced)
# and cannot close the fenced block early; long reports are bounded.
# ---------------------------------------------------------------------------

hostile_transcript="$test_root/hostile.log"
hostile_detail="/Applications/Xcode.app/Contents/Developer ::add-mask::hostile \`\`\`\`closing$(printf '\r')fence"
plan_text="$(cat "$plan_transcript")"
original_xcode_row="| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
hostile_xcode_row="| Xcode with simctl | READY | ${hostile_detail} |"
printf '%s\n' "${plan_text//"$original_xcode_row"/$hostile_xcode_row}" >"$hostile_transcript"
"$GREP_BIN" -Fq -- '::add-mask::hostile ````closing' "$hostile_transcript" || fail "the hostile fixture did not replace the Xcode row"
hostile_summary="$test_root/summary-hostile.md"
hostile_output="$(run_checker hostile-report-text-is-sanitized 0 "$hostile_transcript" --summary "$hostile_summary")"
assert_contains "$hostile_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
hostile_summary_text="$(cat "$hostile_summary")"
assert_not_contains "$hostile_summary_text" "::add-mask::"
assert_contains "$hostile_summary_text" "&#58;&#58;add-mask&#58;&#58;hostile"
if LC_ALL=C "$GREP_BIN" -q "$(printf '\r')" "$hostile_summary"; then
  fail "control characters must not reach the job summary"
fi
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````text$' "$hostile_summary")" == "1" ]] || fail "the fenced block must open with a fence longer than any backtick run in the quoted text"
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````$' "$hostile_summary")" == "1" ]] || fail "the fenced block must close with a fence longer than any backtick run in the quoted text"
if LC_ALL=C "$GREP_BIN" -q '^```text$' "$hostile_summary"; then
  fail "a three-backtick fence would be closed early by the quoted text"
fi
# A report without long backtick runs keeps the ordinary three-backtick fence.
[[ "$(LC_ALL=C "$GREP_BIN" -c '^```text$' "$plan_summary")" == "1" ]] || fail "an ordinary report must be fenced with three backticks"

long_transcript="$test_root/long.log"
{
  cat "$plan_transcript"
  index=0
  while ((index < 200)); do
    printf 'padding line %s after the report\n' "$index"
    index=$((index + 1))
  done
} >"$long_transcript"
long_summary="$test_root/summary-long.md"
run_checker long-report-is-bounded 0 "$long_transcript" --summary "$long_summary" >/dev/null
long_summary_text="$(cat "$long_summary")"
assert_contains "$long_summary_text" "(truncated to 120 lines and 16384 bytes)"
assert_not_contains "$long_summary_text" "padding line 199 after the report"
[[ "$(wc -l <"$long_summary" | tr -d ' ')" -lt 150 ]] || fail "the bounded summary is too long: $(wc -l <"$long_summary") lines"

# ---------------------------------------------------------------------------
# Usage errors exit 2 and never print a verdict.
# ---------------------------------------------------------------------------

usage_output="$("$BASH_BIN" "$CHECKER" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$usage_output" "the dry-run transcript path is required"
assert_contains "$usage_output" "exit=2"
assert_not_contains "$usage_output" "IOS_RUNNER_DRY_RUN_CHECK="
missing_output="$("$BASH_BIN" "$CHECKER" "$test_root/does-not-exist.log" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$missing_output" "transcript not found"
assert_contains "$missing_output" "exit=2"
summary_flag_output="$("$BASH_BIN" "$CHECKER" "$plan_transcript" --summary 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$summary_flag_output" "--summary needs a file path"
assert_contains "$summary_flag_output" "exit=2"
help_output="$("$BASH_BIN" "$CHECKER" --help)"
assert_contains "$help_output" "Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]"

cleanup_test_fixtures
trap - EXIT

printf 'check-ios-runner-dry-run-report.test.sh: all cases passed\n'
#!/usr/bin/env bash
#
# Exercises scripts/check-ios-runner-dry-run-report.sh, the verdict the
# GitHub-hosted macOS job applies to a real `provision-ios-runner.sh --dry-run`
# transcript. The transcripts come from the real script driven through
# simulated-macOS stubs (uname reporting Darwin, xcrun listings padded with
# trailing whitespace), so the checker is tested against the report format the
# script actually prints. PROVISION_TEST_BASH runs both scripts under another
# bash build (for example bash 3.2.57, the version macOS ships); the hosted
# job runs this suite under /bin/bash.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROVISION="$WORKSPACE_ROOT/scripts/provision-ios-runner.sh"
CHECKER="$WORKSPACE_ROOT/scripts/check-ios-runner-dry-run-report.sh"
CONTRACT="$WORKSPACE_ROOT/scripts/ios-runner-contract.sh"
BASH_BIN="${PROVISION_TEST_BASH:-$(command -v bash)}"
[[ -x "$BASH_BIN" ]] || { printf 'PROVISION_TEST_BASH is not an executable bash: %s\n' "$BASH_BIN" >&2; exit 1; }
ENV_BIN="$(command -v env)"
GREP_BIN="$(command -v grep)"

test_parent="$(mktemp -d)"
test_root="$test_parent/fixtures"
cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"
mkdir -p "$test_root"
printf 'keep\n' >"$cleanup_guard"

cleanup_test_fixtures() {
  rm -rf "$test_root"
  if [[ ! -f "$cleanup_guard" ]]; then
    echo "iOS runner dry-run report check test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output="$1" expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_not_contains() {
  local output="$1" unexpected="$2"
  if "$GREP_BIN" -Fq -- "$unexpected" <<<"$output"; then
    printf 'Expected output not to contain: %s\n%s\n' "$unexpected" "$output" >&2
    exit 1
  fi
}

source "$CONTRACT"
"$BASH_BIN" -n "$CHECKER" || fail "Bash 3.2 syntax check failed for $CHECKER"

# ---------------------------------------------------------------------------
# Simulated macOS in an isolated PATH: the real script's full dry run, with
# the Xcode tooling answered by stubs. XCRUN_RUNTIMES_UNPARSABLE breaks the
# runtime listing's layout and XCRUN_NO_SE_TYPE withdraws the device type.
# ---------------------------------------------------------------------------

utilities="$test_root/utilities"
mkdir -p "$utilities"
for command in sed head tail tr cat mkdir mktemp rm id sort grep find sleep date wc awk; do
  resolved="$(command -v "$command" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || fail "the test host lacks '$command', which the isolated PATH needs"
  ln -s "$resolved" "$utilities/$command"
done

macos_stubs="$test_root/macos-stubs"
mkdir -p "$macos_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "arm64\\n"; else printf "Darwin\\n"; fi\n' "$BASH_BIN" >"$macos_stubs/uname"
printf '#!%s\nprintf "15.6\\n"\n' "$BASH_BIN" >"$macos_stubs/sw_vers"
printf '#!%s\nprintf "/Applications/Xcode.app/Contents/Developer\\n"\n' "$BASH_BIN" >"$macos_stubs/xcode-select"
# A brew stub keeps the dry run away from a real Homebrew (the hosted Mac has
# one at /opt/homebrew/bin/brew, which the script also probes by path).
cat >"$macos_stubs/brew" <<EOF
#!${BASH_BIN}
case "\${1:-}" in
  shellenv) ;;
  --prefix) printf '/opt/homebrew\\n' ;;
  *) printf 'unexpected brew call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
cat >"$macos_stubs/xcrun" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$XCRUN_LOG"
case "\$*" in
  "simctl list devices") ;;
  "simctl list runtimes available")
    printf '== Runtimes ==\\n'
    if [[ -n "\${XCRUN_RUNTIMES_UNPARSABLE:-}" ]]; then
      printf 'iOS 26.0 (26.0 - 23A339) com.apple.CoreSimulator.SimRuntime.iOS-26-0\\n'
    else
      printf 'iOS 26.0 (26.0 - 23A339) - com.apple.CoreSimulator.SimRuntime.iOS-26-0 \\n'
    fi
    printf 'watchOS 26.0 (26.0 - 23R356) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0 \\n'
    ;;
  "simctl list devices available")
    printf '== Devices ==\\n-- iOS 26.0 --\\n'
    printf '    iPhone 17 (11111111-2222-3333-4444-555555555555) (Shutdown) \\n'
    if [[ -n "\${XCRUN_SE_STATE:-}" ]]; then
      printf '    %s (ABCDEF12-3456-7890-ABCD-EF1234567890) (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "\$XCRUN_SE_STATE"
    fi
    ;;
  "simctl list devicetypes")
    printf '== Device Types ==\\n'
    printf 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17) \\n'
    if [[ -z "\${XCRUN_NO_SE_TYPE:-}" ]]; then
      printf '%s (%s) \\n' "${IOS_RUNNER_SIMULATOR_NAME}" "${IOS_RUNNER_SIMULATOR_DEVICE_TYPE}"
    fi
    ;;
  *) printf 'unexpected xcrun call during a dry run: %s\\n' "\$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$macos_stubs"/*

# dry_run_transcript <name> <PATH> [VAR=value ...]: runs the real script's
# dry run non-interactively (stdin closed, no GitHub access, an empty runner
# root) and prints the transcript path.
dry_run_transcript() {
  local name="$1" path="$2"
  shift 2
  local home="$test_root/home-$name" transcript="$test_root/$name.log" status=0
  mkdir -p "$home"
  "$ENV_BIN" -i PATH="$path" HOME="$home" XCRUN_LOG="$test_root/xcrun-$name.log" \
    RUNNER_NAME=ios-release-mac RUNNER_ROOT="$test_root/runner-root-$name" "$@" \
    "$BASH_BIN" "$PROVISION" --dry-run --no-github </dev/null >"$transcript" 2>&1 || status=$?
  [[ "$status" -eq 0 ]] || fail "the $name dry run exited $status:
$(cat "$transcript")"
  if [[ -n "$(find "$home" -mindepth 1 -print -quit)" ]]; then
    fail "the $name dry run wrote under HOME: $(find "$home" -mindepth 1)"
  fi
  [[ ! -e "$test_root/runner-root-$name" ]] || fail "the $name dry run created the runner root"
  printf '%s\n' "$transcript"
}

# run_checker <name> <expected status> <transcript> [checker args ...]
run_checker() {
  local name="$1" expected_status="$2" transcript="$3"
  shift 3
  local output status=0
  output="$("$BASH_BIN" "$CHECKER" "$transcript" "$@" 2>&1)" || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

# ---------------------------------------------------------------------------
# A hosted Mac without the simulator: Xcode and the runtime are READY and the
# simulator row plans the creation, so the check passes and the summary
# quotes the report.
# ---------------------------------------------------------------------------

plan_transcript="$(dry_run_transcript planned-simulator "$macos_stubs:$utilities")"
assert_contains "$(cat "$plan_transcript")" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$(cat "$plan_transcript")" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$(cat "$plan_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$(cat "$plan_transcript")" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_contains "$(cat "$plan_transcript")" "| Homebrew | READY | ${macos_stubs}/brew |"
assert_not_contains "$(cat "$plan_transcript")" "unexpected brew call"
assert_not_contains "$(cat "$plan_transcript")" "unexpected xcrun call"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl create"
assert_not_contains "$(cat "$test_root/xcrun-planned-simulator.log")" "simctl boot"

plan_summary="$test_root/summary-planned.md"
printf 'existing summary content\n' >"$plan_summary"
plan_output="$(run_checker planned-simulator-passes 0 "$plan_transcript" --summary "$plan_summary")"
assert_contains "$plan_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
assert_contains "$plan_output" "Xcode with simctl: READY: /Applications/Xcode.app/Contents/Developer"
assert_contains "$plan_output" "iOS simulator runtime: READY: com.apple.CoreSimulator.SimRuntime.iOS-26-0"
assert_contains "$plan_output" "Booted ${IOS_RUNNER_SIMULATOR_NAME}: MISSING: will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted"
assert_not_contains "$plan_output" "finding:"
[[ "$(printf '%s\n' "$plan_output" | tail -n 1)" == "IOS_RUNNER_DRY_RUN_CHECK=PASS" ]] ||
  fail "the verdict must be the last line of the checker output"
plan_summary_text="$(cat "$plan_summary")"
assert_contains "$plan_summary_text" "existing summary content"
assert_contains "$plan_summary_text" "## iOS runner setup script on a GitHub-hosted Mac"
assert_contains "$plan_summary_text" "- Result: **PASS**"
assert_contains "$plan_summary_text" "### Readiness report (quoted from the dry run)"
assert_contains "$plan_summary_text" "## iOS release runner readiness"
assert_contains "$plan_summary_text" "- Mode: dry run (no changes were made)"
assert_contains "$plan_summary_text" "| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
assert_contains "$plan_summary_text" "| iOS simulator runtime | READY | com.apple.CoreSimulator.SimRuntime.iOS-26-0 |"
assert_contains "$plan_summary_text" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be created on com.apple.CoreSimulator.SimRuntime.iOS-26-0 and booted |"
assert_contains "$plan_summary_text" "nothing was registered or installed"
assert_not_contains "$plan_summary_text" "Findings:"

# The same check passes without a summary file, and a booted simulator
# (READY with its UDID) passes too.
run_checker planned-simulator-passes-without-summary 0 "$plan_transcript" >/dev/null
booted_transcript="$(dry_run_transcript booted-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Booted)"
assert_contains "$(cat "$booted_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | READY | ABCDEF12-3456-7890-ABCD-EF1234567890 |"
booted_output="$(run_checker booted-simulator-passes 0 "$booted_transcript")"
assert_contains "$booted_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
shutdown_transcript="$(dry_run_transcript shutdown-simulator "$macos_stubs:$utilities" XCRUN_SE_STATE=Shutdown)"
assert_contains "$(cat "$shutdown_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | will be booted (ABCDEF12-3456-7890-ABCD-EF1234567890) |"
shutdown_output="$(run_checker shutdown-simulator-passes 0 "$shutdown_transcript")"
assert_contains "$shutdown_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"

# ---------------------------------------------------------------------------
# Failures the hosted Mac must surface: an unparsed runtime listing, a device
# type the Xcode no longer offers, a Linux transcript, an unfinished run, a
# transcript without the report, and a non-dry-run report.
# ---------------------------------------------------------------------------

unparsed_transcript="$(dry_run_transcript unparsed-runtime "$macos_stubs:$utilities" XCRUN_RUNTIMES_UNPARSABLE=1)"
assert_contains "$(cat "$unparsed_transcript")" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"
unparsed_summary="$test_root/summary-unparsed.md"
unparsed_output="$(run_checker unparsed-runtime-fails 1 "$unparsed_transcript" --summary "$unparsed_summary")"
assert_contains "$unparsed_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$unparsed_output" "finding: iOS simulator runtime is MISSING on a hosted Mac (the runtime listing was not parsed, or the image lacks an iOS runtime): run: xcodebuild -downloadPlatform iOS"
assert_contains "$unparsed_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): will be created on an iOS runtime and booted"
assert_not_contains "$unparsed_output" "finding: Xcode with simctl"
unparsed_summary_text="$(cat "$unparsed_summary")"
assert_contains "$unparsed_summary_text" "- Result: **FAIL**"
assert_contains "$unparsed_summary_text" "- Findings:"
assert_contains "$unparsed_summary_text" "  - iOS simulator runtime is MISSING on a hosted Mac"
assert_contains "$unparsed_summary_text" "| iOS simulator runtime | MISSING | run: xcodebuild -downloadPlatform iOS"

no_type_transcript="$(dry_run_transcript unavailable-device-type "$macos_stubs:$utilities" XCRUN_NO_SE_TYPE=1)"
assert_contains "$(cat "$no_type_transcript")" "| Booted ${IOS_RUNNER_SIMULATOR_NAME} | MISSING | cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode; check 'xcrun simctl list devicetypes' |"
no_type_output="$(run_checker unavailable-device-type-fails 1 "$no_type_transcript")"
assert_contains "$no_type_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$no_type_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is MISSING without a plan (the device type or the runtime could not be resolved): cannot be created: ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} is not offered by the installed Xcode"
assert_not_contains "$no_type_output" "finding: iOS simulator runtime"

linux_stubs="$test_root/linux-stubs"
mkdir -p "$linux_stubs"
printf '#!%s\nif [[ "${1:-}" == -m ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n' "$BASH_BIN" >"$linux_stubs/uname"
chmod +x "$linux_stubs/uname"
linux_transcript="$(dry_run_transcript linux-host "$linux_stubs:$utilities")"
assert_contains "$(cat "$linux_transcript")" "| Xcode with simctl | SKIPPED |"
linux_output="$(run_checker linux-transcript-fails 1 "$linux_transcript")"
assert_contains "$linux_output" "IOS_RUNNER_DRY_RUN_CHECK=FAIL"
assert_contains "$linux_output" "finding: the report was not produced on macOS (- Host: Linux (x86_64); dry run only, macOS-only checks skipped)"
assert_contains "$linux_output" "finding: Xcode with simctl is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: iOS simulator runtime is SKIPPED on a hosted Mac"
assert_contains "$linux_output" "finding: Booted ${IOS_RUNNER_SIMULATOR_NAME} is SKIPPED instead of READY or a planned MISSING"

unfinished_transcript="$test_root/unfinished.log"
grep -v '^IOS_RELEASE_RUNNER=' "$plan_transcript" >"$unfinished_transcript"
unfinished_output="$(run_checker unfinished-run-fails 1 "$unfinished_transcript")"
assert_contains "$unfinished_output" "finding: the dry run did not finish (no IOS_RELEASE_RUNNER= line after the report)"

truncated_transcript="$test_root/truncated.log"
head -n 12 "$plan_transcript" >"$truncated_transcript"
printf 'error: something stopped the dry run early\n' >>"$truncated_transcript"
truncated_summary="$test_root/summary-truncated.md"
truncated_output="$(run_checker missing-report-fails 1 "$truncated_transcript" --summary "$truncated_summary")"
assert_contains "$truncated_output" "finding: the transcript has no '## iOS release runner readiness' report; the dry run stopped before printing it"
assert_contains "$truncated_output" "Xcode with simctl: not reported"
truncated_summary_text="$(cat "$truncated_summary")"
assert_contains "$truncated_summary_text" "- Result: **FAIL**"
assert_contains "$truncated_summary_text" "### Dry-run transcript (last 40 lines; no readiness report was printed)"
assert_contains "$truncated_summary_text" "error: something stopped the dry run early"

not_dry_run_transcript="$test_root/not-dry-run.log"
grep -v '^- Mode: dry run' "$plan_transcript" >"$not_dry_run_transcript"
not_dry_run_output="$(run_checker non-dry-run-report-fails 1 "$not_dry_run_transcript")"
assert_contains "$not_dry_run_output" "finding: the report was not produced by a dry run (no '- Mode: dry run (no changes were made)' line)"

# ---------------------------------------------------------------------------
# Summary safety: quoted report text is sanitized at the workflow output
# boundary (workflow-command sentinels encoded, control characters replaced)
# and cannot close the fenced block early; long reports are bounded.
# ---------------------------------------------------------------------------

hostile_transcript="$test_root/hostile.log"
hostile_detail="/Applications/Xcode.app/Contents/Developer ::add-mask::hostile \`\`\`\`closing$(printf '\r')fence"
plan_text="$(cat "$plan_transcript")"
original_xcode_row="| Xcode with simctl | READY | /Applications/Xcode.app/Contents/Developer |"
hostile_xcode_row="| Xcode with simctl | READY | ${hostile_detail} |"
printf '%s\n' "${plan_text//"$original_xcode_row"/$hostile_xcode_row}" >"$hostile_transcript"
"$GREP_BIN" -Fq -- '::add-mask::hostile ````closing' "$hostile_transcript" || fail "the hostile fixture did not replace the Xcode row"
hostile_summary="$test_root/summary-hostile.md"
hostile_output="$(run_checker hostile-report-text-is-sanitized 0 "$hostile_transcript" --summary "$hostile_summary")"
assert_contains "$hostile_output" "IOS_RUNNER_DRY_RUN_CHECK=PASS"
hostile_summary_text="$(cat "$hostile_summary")"
assert_not_contains "$hostile_summary_text" "::add-mask::"
assert_contains "$hostile_summary_text" "&#58;&#58;add-mask&#58;&#58;hostile"
if LC_ALL=C "$GREP_BIN" -q "$(printf '\r')" "$hostile_summary"; then
  fail "control characters must not reach the job summary"
fi
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````text$' "$hostile_summary")" == "1" ]] || fail "the fenced block must open with a fence longer than any backtick run in the quoted text"
[[ "$(LC_ALL=C "$GREP_BIN" -c '^`````$' "$hostile_summary")" == "1" ]] || fail "the fenced block must close with a fence longer than any backtick run in the quoted text"
if LC_ALL=C "$GREP_BIN" -q '^```text$' "$hostile_summary"; then
  fail "a three-backtick fence would be closed early by the quoted text"
fi
# A report without long backtick runs keeps the ordinary three-backtick fence.
[[ "$(LC_ALL=C "$GREP_BIN" -c '^```text$' "$plan_summary")" == "1" ]] || fail "an ordinary report must be fenced with three backticks"

long_transcript="$test_root/long.log"
{
  cat "$plan_transcript"
  index=0
  while ((index < 200)); do
    printf 'padding line %s after the report\n' "$index"
    index=$((index + 1))
  done
} >"$long_transcript"
long_summary="$test_root/summary-long.md"
run_checker long-report-is-bounded 0 "$long_transcript" --summary "$long_summary" >/dev/null
long_summary_text="$(cat "$long_summary")"
assert_contains "$long_summary_text" "(truncated to 120 lines and 16384 bytes)"
assert_not_contains "$long_summary_text" "padding line 199 after the report"
[[ "$(wc -l <"$long_summary" | tr -d ' ')" -lt 150 ]] || fail "the bounded summary is too long: $(wc -l <"$long_summary") lines"

# ---------------------------------------------------------------------------
# Usage errors exit 2 and never print a verdict.
# ---------------------------------------------------------------------------

usage_output="$("$BASH_BIN" "$CHECKER" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$usage_output" "the dry-run transcript path is required"
assert_contains "$usage_output" "exit=2"
assert_not_contains "$usage_output" "IOS_RUNNER_DRY_RUN_CHECK="
missing_output="$("$BASH_BIN" "$CHECKER" "$test_root/does-not-exist.log" 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$missing_output" "transcript not found"
assert_contains "$missing_output" "exit=2"
summary_flag_output="$("$BASH_BIN" "$CHECKER" "$plan_transcript" --summary 2>&1 || printf '\nexit=%s' "$?")"
assert_contains "$summary_flag_output" "--summary needs a file path"
assert_contains "$summary_flag_output" "exit=2"
help_output="$("$BASH_BIN" "$CHECKER" --help)"
assert_contains "$help_output" "Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]"

cleanup_test_fixtures
trap - EXIT

printf 'check-ios-runner-dry-run-report.test.sh: all cases passed\n'
