#!/usr/bin/env bash
#
# Check the complete Android native-release gate contract without launching the
# app or running Maestro. This is intended to fail fast on a prepared runner.
#
# The candidate identifiers and smoke-account values are supplied by the
# workflow secret store. Never print their values from this script.

set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "$SCRIPT_DIR" == "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="."
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_DIR" && pwd)"
# shellcheck source=scripts/workflow-output-safety.sh
source "$SCRIPT_DIR/workflow-output-safety.sh"
# shellcheck source=scripts/android-runner-pins.sh
source "$SCRIPT_DIR/android-runner-pins.sh"

failures=()

record_failure() {
  failures+=("$1")
}

check_command() {
  local command="$1"
  if ! command -v "$command" >/dev/null 2>&1; then
    record_failure "Required command is missing: ${command}"
  fi
}

check_environment_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    record_failure "Required release value is missing: ${name}"
  fi
}

write_summary() {
  local status="$1"
  {
    echo "## Android release runner preflight"
    echo
    echo "- Status: **${status}**"
    if ((${#failures[@]})); then
      echo
      echo "### Blocking prerequisites"
      for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$(sanitize_workflow_text "$failure")"
      done
    fi
  } >&2

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## Android release runner preflight"
      echo
      echo "- Status: **${status}**"
      if ((${#failures[@]})); then
        echo
        echo "### Blocking prerequisites"
        for failure in "${failures[@]}"; do
          printf -- '- %s\n' "$(sanitize_workflow_text "$failure")"
        done
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  record_failure "The Android release runner must be Linux x86_64."
fi

for command in adb sdkmanager avdmanager emulator java pnpm maestro timeout; do
  check_command "$command"
done

if command -v java >/dev/null 2>&1; then
  java_version="$(
    java -version 2>&1 |
      sed -nE 's/.*version "([^"]+)".*/\1/p' |
      head -n 1
  )"
  if [[ -z "$java_version" ]]; then
    record_failure "Could not determine the installed Java version; Java 17 or newer is required."
  else
    java_major="${java_version%%.*}"
    if [[ "$java_major" == "1" ]]; then
      java_major="${java_version#1.}"
      java_major="${java_major%%.*}"
    fi
    if ! [[ "$java_major" =~ ^[0-9]+$ ]]; then
      record_failure "Could not determine the installed Java major version from ${java_version}; Java 17 or newer is required."
    elif ((java_major < 17)); then
      record_failure "Java 17 or newer is required; found Java ${java_version}."
    fi
  fi
fi

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$SDK_ROOT" ]]; then
  record_failure "ANDROID_SDK_ROOT or ANDROID_HOME must be set."
elif [[ ! -d "$SDK_ROOT" ]]; then
  record_failure "Android SDK directory does not exist: ${SDK_ROOT}"
fi

aapt2_path=""
if [[ -n "$SDK_ROOT" ]]; then
  aapt2_path="$SDK_ROOT/build-tools/$ANDROID_BUILD_TOOLS_VERSION/aapt2"
fi
if [[ ! -x "$aapt2_path" ]]; then
  record_failure "Required Android SDK tool is missing: aapt2."
fi

for value in NATIVE_SMOKE_APP_ID NATIVE_SMOKE_BUILD_ID NATIVE_SMOKE_EMAIL NATIVE_SMOKE_PASSWORD; do
  check_environment_value "$value"
done

device_ready=0
if command -v adb >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  wait_seconds="${ANDROID_PREFLIGHT_DEVICE_TIMEOUT_SECONDS:-60}"
  if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]] || ((wait_seconds < 1)); then
    record_failure "ANDROID_PREFLIGHT_DEVICE_TIMEOUT_SECONDS must be a positive integer."
  elif timeout "${wait_seconds}s" adb wait-for-device >/dev/null 2>&1 && adb get-state >/dev/null 2>&1; then
    device_ready=1
  else
    record_failure "No ready Android emulator or device responded to adb within ${wait_seconds} seconds."
  fi
fi

if ((device_ready)); then
  size="$(adb shell wm size 2>/dev/null | tr -d '\r' | tail -n 1 | sed 's/^.*: //')"
  density="$(adb shell wm density 2>/dev/null | tr -d '\r' | tail -n 1 | sed 's/^.*: //')"
  IFS=x read -r width_px height_px <<<"$size"
  if [[ ! "$width_px" =~ ^[0-9]+$ || ! "$height_px" =~ ^[0-9]+$ || ! "$density" =~ ^[0-9]+$ || "$density" == "0" ]]; then
    record_failure "Could not determine Android device size and density."
  else
    width_dp=$((width_px * 160 / density))
    height_dp=$((height_px * 160 / density))
    if ((width_dp > 320 || height_dp > 568)); then
      record_failure "The Android runner must use an emulator at or below 320x568 dp; found ${width_dp}x${height_dp} dp."
    fi
  fi

  rotation="$(adb shell settings get system user_rotation 2>/dev/null | tr -d '\r' | tr -d '[:space:]')"
  if [[ "$rotation" != "0" && "$rotation" != "2" ]]; then
    record_failure "The Android runner must be in portrait orientation; found user_rotation=${rotation:-unknown}."
  fi

  # The application ID is a release secret: name the condition, never the value.
  if [[ -n "${NATIVE_SMOKE_APP_ID:-}" ]] && ! adb shell pm path "$NATIVE_SMOKE_APP_ID" >/dev/null 2>&1; then
    record_failure "The release-candidate application is not installed on the connected device."
  fi
fi

if ((${#failures[@]})); then
  echo "ANDROID_RELEASE_PREFLIGHT=BLOCKED" >&2
  write_summary "BLOCKED"
  exit 2
fi

echo "ANDROID_RELEASE_PREFLIGHT=READY"
write_summary "READY"