#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "Usage: pnpm --filter @workspace/chat-app test:native-large-text ios|android" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHAT_APP_DIR="$ROOT_DIR/artifacts/chat-app"
WRITE_REVIEW_RECORD_TEMPLATE="$CHAT_APP_DIR/e2e/native-large-text/write-review-record-template.sh"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
SMALLEST_IOS_DEVICE="iPhone SE (3rd generation)"

# NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is a local iOS troubleshooting override.
# Setting it marks the whole run as diagnostic-only, even when the smallest
# supported simulator happens to be booted, so its output can never be mistaken
# for release evidence. Release workflow runs (GitHub Actions) refuse it.
LARGER_DEVICE_OVERRIDE=0
if [[ "$PLATFORM" == "ios" && "${NATIVE_SMOKE_ALLOW_LARGER_DEVICE:-0}" == "1" ]]; then
  LARGER_DEVICE_OVERRIDE=1
fi
RELEASE_WORKFLOW_RUN=0
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  RELEASE_WORKFLOW_RUN=1
fi
RUN_MODE="release-gate"
if [[ "$LARGER_DEVICE_OVERRIDE" == "1" && "$RELEASE_WORKFLOW_RUN" == "0" ]]; then
  RUN_MODE="diagnostic-only"
fi

# Diagnostic-only output defaults to its own tree so the release evidence
# directory validated by scripts/check-native-large-text-evidence.sh never
# receives it by accident.
if [[ -n "${NATIVE_SMOKE_RESULTS_DIR:-}" ]]; then
  RESULTS_DIR="$NATIVE_SMOKE_RESULTS_DIR"
elif [[ "$RUN_MODE" == "diagnostic-only" ]]; then
  RESULTS_DIR="$ROOT_DIR/test-results/native-large-text-diagnostic/$PLATFORM/$RUN_ID"
else
  RESULTS_DIR="$ROOT_DIR/test-results/native-large-text/$PLATFORM/$RUN_ID"
fi
mkdir -p "$RESULTS_DIR"

if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
  echo "DIAGNOSTIC-ONLY RUN: NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is set. This output is not release evidence." >&2
fi

IOS_READINESS_BLOCKERS=()
IOS_MAESTRO_STATUS="BLOCKED"
IOS_PNPM_STATUS="BLOCKED"
IOS_XCRUN_STATUS="BLOCKED"
IOS_SIMULATOR_STATUS="BLOCKED"
IOS_SIMULATOR_DETAIL=""
IOS_RELEASE_CONFIGURATION_STATUS="BLOCKED"
BOOTED_DEVICE=""
IOS_DEVICE_UDID=""

record_ios_readiness_failure() {
  IOS_READINESS_BLOCKERS+=("$1")
}

write_ios_readiness_summary() {
  if [[ "$PLATFORM" != "ios" ]]; then
    return
  fi

  local status="READY"
  if ((${#IOS_READINESS_BLOCKERS[@]})); then
    status="BLOCKED"
  fi

  {
    if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
      echo "## iOS native large-text readiness (DIAGNOSTIC-ONLY)"
    else
      echo "## iOS native large-text readiness"
    fi
    echo
    echo "- Status: **${status}**"
    if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
      echo "- Run mode: **DIAGNOSTIC-ONLY** (not release evidence)"
    else
      echo "- Run mode: **RELEASE GATE**"
    fi
    echo
    echo "### Prerequisites"
    echo "- Maestro: **${IOS_MAESTRO_STATUS}**"
    echo "- pnpm: **${IOS_PNPM_STATUS}**"
    echo "- Xcode simulator tooling: **${IOS_XCRUN_STATUS}**"
    echo "- Booted ${SMALLEST_IOS_DEVICE}: **${IOS_SIMULATOR_STATUS}**${IOS_SIMULATOR_DETAIL}"
    echo "- Release configuration: **${IOS_RELEASE_CONFIGURATION_STATUS}**"
    if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
      echo
      echo "### Diagnostic-only run"
      echo "- NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is set, so this run is local troubleshooting output and must not be used as release evidence."
      if [[ -n "$BOOTED_DEVICE" && "$BOOTED_DEVICE" != "$SMALLEST_IOS_DEVICE" ]]; then
        echo "- The override accepted a larger simulator: ${BOOTED_DEVICE}."
      fi
      echo "- Unset NATIVE_SMOKE_ALLOW_LARGER_DEVICE and re-run on a booted ${SMALLEST_IOS_DEVICE} to produce release evidence."
    fi
    if ((${#IOS_READINESS_BLOCKERS[@]})); then
      echo
      echo "### Blocking prerequisites"
      printf -- '- %s\n' "${IOS_READINESS_BLOCKERS[@]}"
    fi
  } > "$RESULTS_DIR/ios-readiness.md"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" && "${NATIVE_SMOKE_SUMMARY_DEFER:-0}" != "1" ]]; then
    cat "$RESULTS_DIR/ios-readiness.md" >> "$GITHUB_STEP_SUMMARY"
  fi
}

for command in maestro pnpm; do
  if command -v "$command" >/dev/null 2>&1; then
    if [[ "$command" == "maestro" ]]; then
      IOS_MAESTRO_STATUS="READY"
    else
      IOS_PNPM_STATUS="READY"
    fi
  else
    echo "Required command not found: $command" >&2
    record_ios_readiness_failure "Required command not found: $command"
  fi
done

if [[ "$LARGER_DEVICE_OVERRIDE" == "1" && "$RELEASE_WORKFLOW_RUN" == "1" ]]; then
  echo "NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is not permitted in release workflow runs; it is a local diagnostic-only override." >&2
  echo "Unset it on the runner and re-run on a booted ${SMALLEST_IOS_DEVICE}." >&2
  record_ios_readiness_failure "NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 is not permitted in release workflow runs. Unset it on the runner; release evidence requires a booted ${SMALLEST_IOS_DEVICE} without the override."
fi

missing_release_values=()
for value in NATIVE_SMOKE_APP_ID NATIVE_SMOKE_BUILD_ID NATIVE_SMOKE_EMAIL NATIVE_SMOKE_PASSWORD; do
  if [[ -z "${!value:-}" ]]; then
    missing_release_values+=("$value")
  fi
done
if ((${#missing_release_values[@]})); then
  echo "Required release configuration is incomplete." >&2
  record_ios_readiness_failure "Required release configuration is incomplete."
else
  IOS_RELEASE_CONFIGURATION_STATUS="READY"
fi

: "${NATIVE_SMOKE_DISPLAY_NAME:=Large Text Release Check}"
: "${NATIVE_SMOKE_SCHEME:=chat-app}"
export NATIVE_SMOKE_APP_ID NATIVE_SMOKE_EMAIL NATIVE_SMOKE_PASSWORD
export NATIVE_SMOKE_DISPLAY_NAME NATIVE_SMOKE_SCHEME
export NATIVE_SMOKE_SCREENSHOT_DIR="$RESULTS_DIR/screenshots"
export NATIVE_SMOKE_CALL_SCREENSHOT_DIR="$RESULTS_DIR/call-surface"
mkdir -p "$NATIVE_SMOKE_SCREENSHOT_DIR" "$NATIVE_SMOKE_CALL_SCREENSHOT_DIR"
if [[ -n "${NATIVE_SMOKE_BUILD_ID:-}" ]]; then
  printf '%s\n' "$NATIVE_SMOKE_BUILD_ID" > "$RESULTS_DIR/candidate-build-id.txt"
  source "$WRITE_REVIEW_RECORD_TEMPLATE" \
    "$RESULTS_DIR/review-record.template.txt" \
    "$PLATFORM" \
    "$NATIVE_SMOKE_BUILD_ID"
fi

RESULT_STATUS="FAIL"
write_result_record() {
  cat > "$RESULTS_DIR/pass-fail-record.txt" <<EOF
platform=$PLATFORM
run_mode=$RUN_MODE
candidate_build_id=${NATIVE_SMOKE_BUILD_ID:-}
status=$RESULT_STATUS
native_screenshot_count=$(find "$NATIVE_SMOKE_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')
call_surface_screenshot_count=$(find "$NATIVE_SMOKE_CALL_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')
recorded_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}
trap write_result_record EXIT

if ((${#IOS_READINESS_BLOCKERS[@]})); then
  write_ios_readiness_summary
  exit 2
fi

if [[ "$PLATFORM" == "ios" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is required for the iOS smoke test." >&2
    record_ios_readiness_failure "xcrun is required for the iOS smoke test."
  else
    IOS_XCRUN_STATUS="READY"
    BOOTED_DEVICES="$(xcrun simctl list devices booted)"
    IOS_DEVICE_UDID="$(
      sed -n "s/^[[:space:]]*${SMALLEST_IOS_DEVICE//\//\\/} (\([0-9A-F-]\{8,\}\)) (Booted)$/\1/p" <<<"$BOOTED_DEVICES" |
        head -n 1
    )"
    if [[ -n "$IOS_DEVICE_UDID" ]]; then
      BOOTED_DEVICE="$SMALLEST_IOS_DEVICE"
    else
      BOOTED_DEVICE="$(
        sed -n 's/^[[:space:]]*\(.*\) ([0-9A-F-]\{8,\}) (Booted)$/\1/p' <<<"$BOOTED_DEVICES" |
          head -n 1
      )"
    fi
    if [[ -z "$IOS_DEVICE_UDID" && "$RUN_MODE" == "diagnostic-only" ]]; then
      IOS_DEVICE_UDID="$(
        sed -n 's/^[[:space:]]*.* (\([0-9A-F-]\{8,\}\)) (Booted)$/\1/p' <<<"$BOOTED_DEVICES" |
          head -n 1
      )"
    fi
    if [[ -z "$BOOTED_DEVICE" ]]; then
      echo "Boot the smallest supported iOS simulator (iPhone SE, 3rd generation) first." >&2
      record_ios_readiness_failure "No booted ${SMALLEST_IOS_DEVICE} simulator was found."
    elif [[ -z "$IOS_DEVICE_UDID" ]]; then
      echo "Expected a booted iPhone SE simulator, found: $BOOTED_DEVICE" >&2
      echo "Set NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 only for a local, non-release diagnostic run." >&2
      record_ios_readiness_failure "Expected ${SMALLEST_IOS_DEVICE}; found: $BOOTED_DEVICE"
    elif [[ -n "${NATIVE_SMOKE_IOS_DEVICE_UDID:-}" && "$IOS_DEVICE_UDID" != "$NATIVE_SMOKE_IOS_DEVICE_UDID" ]]; then
      echo "The prepared iPhone SE simulator changed after workflow verification." >&2
      record_ios_readiness_failure "The booted ${SMALLEST_IOS_DEVICE} does not match the simulator selected by the workflow verification step."
    elif [[ "$BOOTED_DEVICE" == "$SMALLEST_IOS_DEVICE" ]]; then
      IOS_SIMULATOR_STATUS="READY"
    elif [[ "$RUN_MODE" == "diagnostic-only" ]]; then
      IOS_SIMULATOR_STATUS="OVERRIDDEN"
      IOS_SIMULATOR_DETAIL=" (diagnostic-only override accepted ${BOOTED_DEVICE})"
      echo "DIAGNOSTIC-ONLY RUN: the override accepted a larger simulator (${BOOTED_DEVICE}); release evidence requires a booted ${SMALLEST_IOS_DEVICE}." >&2
    else
      echo "Expected a booted iPhone SE simulator, found: $BOOTED_DEVICE" >&2
      echo "Set NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 only for a local, non-release diagnostic run." >&2
      record_ios_readiness_failure "Expected ${SMALLEST_IOS_DEVICE}; found: $BOOTED_DEVICE"
    fi
  fi
  if ((${#IOS_READINESS_BLOCKERS[@]})); then
    write_ios_readiness_summary
    exit 2
  fi
  write_ios_readiness_summary
  cat > "$RESULTS_DIR/runner-metadata.txt" <<EOF
platform=ios
run_mode=$RUN_MODE
candidate_build_id=${NATIVE_SMOKE_BUILD_ID:-}
app_id=${NATIVE_SMOKE_APP_ID:-}
device=$BOOTED_DEVICE
device_udid=$IOS_DEVICE_UDID
recorded_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
else
  if ! command -v adb >/dev/null 2>&1; then
    echo "adb is required for the Android smoke test." >&2
    exit 2
  fi
  adb get-state >/dev/null
  ANDROID_SERIAL="$(adb get-serialno | tr -d '\r\n')"
  if [[ -z "$ANDROID_SERIAL" || "$ANDROID_SERIAL" == "unknown" ]]; then
    echo "Could not determine the connected Android device serial." >&2
    exit 2
  fi
  if ! adb shell pm path "$NATIVE_SMOKE_APP_ID" >/dev/null 2>&1; then
    echo "The release candidate is not installed on the connected Android device." >&2
    exit 2
  fi
  ANDROID_SIZE="$(adb shell wm size | tr -d '\r' | tail -n 1 | sed 's/^.*: //')"
  ANDROID_DENSITY="$(adb shell wm density | tr -d '\r' | tail -n 1 | sed 's/^.*: //')"
  IFS=x read -r ANDROID_WIDTH_PX ANDROID_HEIGHT_PX <<<"$ANDROID_SIZE"
  if [[ ! "$ANDROID_WIDTH_PX" =~ ^[0-9]+$ || ! "$ANDROID_HEIGHT_PX" =~ ^[0-9]+$ || ! "$ANDROID_DENSITY" =~ ^[0-9]+$ ]]; then
    echo "Could not determine Android emulator size and density." >&2
    exit 2
  fi
  ANDROID_WIDTH_DP=$((ANDROID_WIDTH_PX * 160 / ANDROID_DENSITY))
  ANDROID_HEIGHT_DP=$((ANDROID_HEIGHT_PX * 160 / ANDROID_DENSITY))
  if ((ANDROID_WIDTH_DP > 320 || ANDROID_HEIGHT_DP > 568)); then
    echo "Expected an Android emulator at or below 320x568 dp, found ${ANDROID_WIDTH_DP}x${ANDROID_HEIGHT_DP} dp." >&2
    exit 2
  fi
  ANDROID_ROTATION="$(adb shell settings get system user_rotation | tr -d '\r' | tr -d '[:space:]')"
  if [[ "$ANDROID_ROTATION" != "0" && "$ANDROID_ROTATION" != "2" ]]; then
    echo "Expected the Android device in portrait orientation (user_rotation 0 or 2), found: ${ANDROID_ROTATION:-unknown}." >&2
    exit 2
  fi
  adb_value() {
    adb shell "$@" | tr -d '\r' | tr '\n' ' ' | sed 's/[[:space:]]*$//'
  }
  cat > "$RESULTS_DIR/runner-metadata.txt" <<EOF
platform=android
run_mode=$RUN_MODE
candidate_build_id=$NATIVE_SMOKE_BUILD_ID
app_id=$NATIVE_SMOKE_APP_ID
device_serial=$ANDROID_SERIAL
device_model=$(adb_value getprop ro.product.model)
android_release=$(adb_value getprop ro.build.version.release)
android_api=$(adb_value getprop ro.build.version.sdk)
screen_px=${ANDROID_WIDTH_PX}x${ANDROID_HEIGHT_PX}
screen_dp=${ANDROID_WIDTH_DP}x${ANDROID_HEIGHT_DP}
density_dpi=$ANDROID_DENSITY
user_rotation=$ANDROID_ROTATION
recorded_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
fi

if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
  echo "Running $PLATFORM native large-text DIAGNOSTIC-ONLY smoke test (not release evidence); artifacts: $RESULTS_DIR"
else
  echo "Running $PLATFORM native large-text smoke test; artifacts: $RESULTS_DIR"
fi
cd "$CHAT_APP_DIR"
if [[ "$PLATFORM" == "ios" ]]; then
  maestro --device "$IOS_DEVICE_UDID" test \
    --format JUNIT \
    --output "$RESULTS_DIR/maestro-results.xml" \
    e2e/native-large-text/flows
else
  maestro test \
    --format JUNIT \
    --output "$RESULTS_DIR/maestro-results.xml" \
    e2e/native-large-text/flows
fi

cd "$ROOT_DIR"
pnpm --filter @workspace/api-server exec vitest run \
  src/routes/rooms.call-layout.test.ts \
  --maxWorkers=1

SCREENSHOT_COUNT="$(find "$NATIVE_SMOKE_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')"
if [[ "$SCREENSHOT_COUNT" -lt 11 ]]; then
  echo "Expected at least 11 native screenshots, found $SCREENSHOT_COUNT." >&2
  exit 1
fi

CALL_SCREENSHOT_COUNT="$(find "$NATIVE_SMOKE_CALL_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')"
if [[ "$CALL_SCREENSHOT_COUNT" -ne 2 ]]; then
  echo "Expected 2 independent call screenshots, found $CALL_SCREENSHOT_COUNT." >&2
  exit 1
fi

RESULT_STATUS="PASS"
if [[ "$RUN_MODE" == "diagnostic-only" ]]; then
  echo "Native large-text smoke test passed for $PLATFORM (DIAGNOSTIC-ONLY; not release evidence)."
else
  echo "Native large-text smoke test passed for $PLATFORM."
fi
