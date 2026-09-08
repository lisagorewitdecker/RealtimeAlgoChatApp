#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "Usage: pnpm --filter @workspace/chat-app test:native-large-text ios|android" >&2
  exit 2
fi

for command in maestro pnpm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 2
  fi
done

: "${NATIVE_SMOKE_APP_ID:?Set NATIVE_SMOKE_APP_ID to the installed application ID.}"
: "${NATIVE_SMOKE_BUILD_ID:?Set NATIVE_SMOKE_BUILD_ID to the installed release candidate build ID.}"
: "${NATIVE_SMOKE_EMAIL:?Set NATIVE_SMOKE_EMAIL for the dedicated verified smoke-test account.}"
: "${NATIVE_SMOKE_PASSWORD:?Set NATIVE_SMOKE_PASSWORD for the dedicated smoke-test account.}"
: "${NATIVE_SMOKE_DISPLAY_NAME:=Large Text Release Check}"
: "${NATIVE_SMOKE_SCHEME:=chat-app}"
export NATIVE_SMOKE_APP_ID NATIVE_SMOKE_EMAIL NATIVE_SMOKE_PASSWORD

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHAT_APP_DIR="$ROOT_DIR/artifacts/chat-app"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="${NATIVE_SMOKE_RESULTS_DIR:-$ROOT_DIR/test-results/native-large-text/$PLATFORM/$RUN_ID}"
export NATIVE_SMOKE_DISPLAY_NAME NATIVE_SMOKE_SCHEME
export NATIVE_SMOKE_SCREENSHOT_DIR="$RESULTS_DIR/screenshots"
export NATIVE_SMOKE_CALL_SCREENSHOT_DIR="$RESULTS_DIR/call-surface"
mkdir -p "$NATIVE_SMOKE_SCREENSHOT_DIR" "$NATIVE_SMOKE_CALL_SCREENSHOT_DIR"
printf '%s\n' "$NATIVE_SMOKE_BUILD_ID" > "$RESULTS_DIR/candidate-build-id.txt"

RESULT_STATUS="FAIL"
write_result_record() {
  cat > "$RESULTS_DIR/pass-fail-record.txt" <<EOF
platform=$PLATFORM
candidate_build_id=$NATIVE_SMOKE_BUILD_ID
status=$RESULT_STATUS
native_screenshot_count=$(find "$NATIVE_SMOKE_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')
call_surface_screenshot_count=$(find "$NATIVE_SMOKE_CALL_SCREENSHOT_DIR" -type f -name '*.png' | wc -l | tr -d ' ')
recorded_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}
trap write_result_record EXIT

if [[ "$PLATFORM" == "ios" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is required for the iOS smoke test." >&2
    exit 2
  fi
  BOOTED_DEVICE="$(xcrun simctl list devices booted | sed -n 's/^[[:space:]]*\(.*\) ([-A-F0-9]\{8,\}) (Booted)$/\1/p' | head -n 1)"
  if [[ -z "$BOOTED_DEVICE" ]]; then
    echo "Boot the smallest supported iOS simulator (iPhone SE, 3rd generation) first." >&2
    exit 2
  fi
  if [[ "$BOOTED_DEVICE" != *"iPhone SE"* && "${NATIVE_SMOKE_ALLOW_LARGER_DEVICE:-0}" != "1" ]]; then
    echo "Expected a booted iPhone SE simulator, found: $BOOTED_DEVICE" >&2
    echo "Set NATIVE_SMOKE_ALLOW_LARGER_DEVICE=1 only for a non-release diagnostic run." >&2
    exit 2
  fi
  cat > "$RESULTS_DIR/runner-metadata.txt" <<EOF
platform=ios
candidate_build_id=$NATIVE_SMOKE_BUILD_ID
app_id=$NATIVE_SMOKE_APP_ID
device=$BOOTED_DEVICE
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
    echo "The release candidate is not installed for application ID $NATIVE_SMOKE_APP_ID." >&2
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

echo "Running $PLATFORM native large-text smoke test; artifacts: $RESULTS_DIR"
cd "$CHAT_APP_DIR"
maestro test \
  --format JUNIT \
  --output "$RESULTS_DIR/maestro-results.xml" \
  e2e/native-large-text/flows

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
echo "Native large-text smoke test passed for $PLATFORM."
