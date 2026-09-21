#!/usr/bin/env bash
#
# Reviews the transcript of `scripts/provision-ios-runner.sh --dry-run` from a
# real Mac (the GitHub-hosted macOS job in
# .github/workflows/ios-runner-provisioning-real-macos.yml) and fails when a
# row that depends on the machine's Xcode is anything other than READY or a
# MISSING row that names a plan. A hosted Mac always ships Xcode with an iOS
# simulator runtime, so MISSING there means the detection or the simctl
# parsing broke; the iPhone SE simulator itself may be absent as long as the
# dry run can plan its creation on a parsed runtime. Keep this file compatible
# with the bash 3.2 that macOS ships.
#
# Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]
#
# <transcript> is the dry run's combined stdout and stderr. With --summary, a
# Markdown section quoting the readiness report is appended to <file> (the
# job's GITHUB_STEP_SUMMARY). The report lists configuration names only, never
# values, and everything quoted passes through the workflow output sanitizer.
# The last line printed is IOS_RUNNER_DRY_RUN_CHECK=PASS or =FAIL; the exit
# status is 0 for PASS, 1 for FAIL, and 2 for usage errors.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios-runner-contract.sh
source "$SCRIPT_DIR/ios-runner-contract.sh"
# shellcheck source=scripts/workflow-output-safety.sh
source "$SCRIPT_DIR/workflow-output-safety.sh"

REPORT_HEADING="## iOS release runner readiness"
DRY_RUN_MODE_LINE="- Mode: dry run (no changes were made)"
XCODE_ROW="Xcode with simctl"
RUNTIME_ROW="iOS simulator runtime"
SIMULATOR_ROW="Booted ${IOS_RUNNER_SIMULATOR_NAME}"
RUNTIME_PATTERN='com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9][0-9-]*'
UDID_PATTERN='[0-9A-F-]{8,}'
# Bounds for the quoted report in the job summary.
SUMMARY_MAX_LINES=120
SUMMARY_MAX_BYTES=16384
TRANSCRIPT_TAIL_LINES=40

usage() {
  cat <<'EOF'
Usage: check-ios-runner-dry-run-report.sh <transcript> [--summary <file>]

Checks a `provision-ios-runner.sh --dry-run` transcript captured on a real
Mac. Xcode and the iOS simulator runtime rows must be READY and the simulator
row must be READY or a MISSING row that plans the boot or the creation on a
parsed runtime; a Linux transcript, a missing report, or an unfinished run
fails. --summary appends a Markdown section quoting the report to <file>.
EOF
}

usage_error() {
  printf 'error: %s\n' "$1" >&2
  usage >&2
  exit 2
}

TRANSCRIPT=""
SUMMARY_PATH=""
while (($#)); do
  case "$1" in
    --summary)
      (($# >= 2)) || usage_error "--summary needs a file path"
      SUMMARY_PATH="$2"
      shift
      ;;
    --summary=*) SUMMARY_PATH="${1#--summary=}" ;;
    --help | -h)
      usage
      exit 0
      ;;
    -*) usage_error "Unknown option: $1" ;;
    *)
      [[ -z "$TRANSCRIPT" ]] || usage_error "only one transcript may be given"
      TRANSCRIPT="$1"
      ;;
  esac
  shift
done
[[ -n "$TRANSCRIPT" ]] || usage_error "the dry-run transcript path is required"
[[ -f "$TRANSCRIPT" ]] || {
  printf 'error: transcript not found: %s\n' "$TRANSCRIPT" >&2
  exit 2
}

FINDINGS=()
finding() {
  FINDINGS+=("$1")
}

matches() {
  # matches <text> <extended regex>
  printf '%s\n' "$1" | grep -Eq -- "$2"
}

# The readiness report is everything from its heading to the end of the
# transcript; the trailing IOS_RELEASE_RUNNER= line proves the run finished.
report="$(sed -n "/^${REPORT_HEADING}\$/,\$p" "$TRANSCRIPT")"

# report_row <prerequisite>: the table row for one prerequisite (empty when
# absent). Prerequisite names never contain '|', so the cells parse with sed.
report_row() {
  printf '%s\n' "$report" | grep -F -- "| $1 | " | head -n 1
}
row_status() {
  printf '%s\n' "$1" | sed 's/^| [^|]* | \([A-Z]*\) | .* |$/\1/'
}
row_detail() {
  printf '%s\n' "$1" | sed 's/^| [^|]* | [A-Z]* | \(.*\) |$/\1/'
}

xcode_summary="not reported"
runtime_summary="not reported"
simulator_summary="not reported"

if [[ -z "$report" ]]; then
  finding "the transcript has no '${REPORT_HEADING}' report; the dry run stopped before printing it"
else
  if ! printf '%s\n' "$report" | grep -Fqx -- "$DRY_RUN_MODE_LINE"; then
    finding "the report was not produced by a dry run (no '${DRY_RUN_MODE_LINE}' line)"
  fi

  host_line="$(printf '%s\n' "$report" | grep -F -- "- Host: " | head -n 1)"
  if [[ "$host_line" != "- Host: macOS "* ]]; then
    finding "the report was not produced on macOS (${host_line:-no host line}); the Xcode rows are skipped elsewhere, so nothing was verified"
  fi

  xcode_row="$(report_row "$XCODE_ROW")"
  if [[ -z "$xcode_row" ]]; then
    finding "the '${XCODE_ROW}' row is missing from the report"
  else
    xcode_status="$(row_status "$xcode_row")"
    xcode_detail="$(row_detail "$xcode_row")"
    xcode_summary="${xcode_status}: ${xcode_detail}"
    if [[ "$xcode_status" != "READY" ]]; then
      finding "${XCODE_ROW} is ${xcode_status} on a hosted Mac: ${xcode_detail}"
    fi
  fi

  runtime_row="$(report_row "$RUNTIME_ROW")"
  if [[ -z "$runtime_row" ]]; then
    finding "the '${RUNTIME_ROW}' row is missing from the report"
  else
    runtime_status="$(row_status "$runtime_row")"
    runtime_detail="$(row_detail "$runtime_row")"
    runtime_summary="${runtime_status}: ${runtime_detail}"
    if [[ "$runtime_status" != "READY" ]]; then
      finding "${RUNTIME_ROW} is ${runtime_status} on a hosted Mac (the runtime listing was not parsed, or the image lacks an iOS runtime): ${runtime_detail}"
    elif ! matches "$runtime_detail" "^${RUNTIME_PATTERN}\$"; then
      finding "${RUNTIME_ROW} is READY but does not name an iOS runtime identifier: ${runtime_detail}"
    fi
  fi

  simulator_row="$(report_row "$SIMULATOR_ROW")"
  if [[ -z "$simulator_row" ]]; then
    finding "the '${SIMULATOR_ROW}' row is missing from the report"
  else
    simulator_status="$(row_status "$simulator_row")"
    simulator_detail="$(row_detail "$simulator_row")"
    simulator_summary="${simulator_status}: ${simulator_detail}"
    case "$simulator_status" in
      READY)
        if ! matches "$simulator_detail" "^${UDID_PATTERN}\$"; then
          finding "${SIMULATOR_ROW} is READY without a device UDID: ${simulator_detail}"
        fi
        ;;
      MISSING)
        if ! matches "$simulator_detail" "^will be booted \(${UDID_PATTERN}\)\$" &&
          ! matches "$simulator_detail" "^will be created on ${RUNTIME_PATTERN} and booted\$"; then
          finding "${SIMULATOR_ROW} is MISSING without a plan (the device type or the runtime could not be resolved): ${simulator_detail}"
        fi
        ;;
      *)
        finding "${SIMULATOR_ROW} is ${simulator_status} instead of READY or a planned MISSING: ${simulator_detail}"
        ;;
    esac
  fi

  if ! grep -Eq -- '^IOS_RELEASE_RUNNER=(READY|INCOMPLETE)$' "$TRANSCRIPT"; then
    finding "the dry run did not finish (no IOS_RELEASE_RUNNER= line after the report)"
  fi
fi

if ((${#FINDINGS[@]})); then
  RESULT="FAIL"
else
  RESULT="PASS"
fi

# ---------------------------------------------------------------------------
# Job summary
# ---------------------------------------------------------------------------

# code_fence_for <text>: a backtick fence longer than any backtick run inside
# the text, so quoted output cannot close the fence early.
code_fence_for() {
  local longest width=3
  longest="$(
    printf '%s\n' "$1" |
      awk '{ n = 0; for (i = 1; i <= length($0); i++) { if (substr($0, i, 1) == "`") { n++; if (n > m) m = n } else n = 0 } } END { print m + 0 }'
  )"
  if ((longest >= width)); then
    width=$((longest + 1))
  fi
  printf '%*s' "$width" '' | tr ' ' '`'
}

# quoted_block <title> <text>: a sanitized, bounded fenced block.
quoted_block() {
  local title="$1" text="$2" fence bounded lines bytes note=""
  lines="$(printf '%s\n' "$text" | wc -l | tr -d ' ')"
  bytes="$(printf '%s\n' "$text" | wc -c | tr -d ' ')"
  # One awk stage applies both bounds and reads its input to the end. A
  # `head -n | head -c` chain exits as soon as its bound is met, and under
  # `pipefail` the producer still writing into the closed pipe turns the whole
  # command into a SIGPIPE failure (exit 141), which depends on scheduling and
  # so surfaced only under load.
  bounded="$(printf '%s\n' "$text" | LC_ALL=C awk -v max_lines="$SUMMARY_MAX_LINES" -v max_bytes="$SUMMARY_MAX_BYTES" '
    NR > max_lines { next }
    {
      line = $0 "\n"
      if (bytes + length(line) <= max_bytes) {
        printf "%s", line
        bytes += length(line)
      } else if (bytes < max_bytes) {
        printf "%s", substr(line, 1, max_bytes - bytes)
        bytes = max_bytes
      }
    }' | sanitize_workflow_stream)"
  if ((lines > SUMMARY_MAX_LINES || bytes > SUMMARY_MAX_BYTES)); then
    note=" (truncated to ${SUMMARY_MAX_LINES} lines and ${SUMMARY_MAX_BYTES} bytes)"
  fi
  fence="$(code_fence_for "$bounded")"
  printf '### %s%s\n\n%stext\n%s\n%s\n\n' "$title" "$note" "$fence" "$bounded" "$fence"
}

write_summary() {
  local item
  {
    printf '## iOS runner setup script on a GitHub-hosted Mac\n\n'
    printf -- '- Result: **%s**\n' "$RESULT"
    printf -- '- %s: %s\n' "$XCODE_ROW" "$(sanitize_workflow_text "$xcode_summary")"
    printf -- '- %s: %s\n' "$RUNTIME_ROW" "$(sanitize_workflow_text "$runtime_summary")"
    printf -- '- %s: %s\n' "$SIMULATOR_ROW" "$(sanitize_workflow_text "$simulator_summary")"
    if ((${#FINDINGS[@]})); then
      printf -- '- Findings:\n'
      for item in "${FINDINGS[@]}"; do
        printf -- '  - %s\n' "$(sanitize_workflow_text "$item")"
      done
    else
      printf -- '- `scripts/provision-ios-runner.sh --dry-run` detected Xcode, parsed the iOS runtime listing, and resolved the simulator plan on this Mac; nothing was registered or installed.\n'
    fi
    printf '\n'
    if [[ -n "$report" ]]; then
      quoted_block "Readiness report (quoted from the dry run)" "$report"
    else
      quoted_block "Dry-run transcript (last ${TRANSCRIPT_TAIL_LINES} lines; no readiness report was printed)" "$(tail -n "$TRANSCRIPT_TAIL_LINES" "$TRANSCRIPT")"
    fi
  } >>"$SUMMARY_PATH"
}

if [[ -n "$SUMMARY_PATH" ]]; then
  write_summary
fi

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

printf 'iOS runner dry-run report check for %s\n' "$TRANSCRIPT"
printf '  %s: %s\n' "$XCODE_ROW" "$xcode_summary"
printf '  %s: %s\n' "$RUNTIME_ROW" "$runtime_summary"
printf '  %s: %s\n' "$SIMULATOR_ROW" "$simulator_summary"
if ((${#FINDINGS[@]})); then
  for item in "${FINDINGS[@]}"; do
    printf 'finding: %s\n' "$item"
  done
fi
printf 'IOS_RUNNER_DRY_RUN_CHECK=%s\n' "$RESULT"
if [[ "$RESULT" == "PASS" ]]; then
  exit 0
fi
exit 1
