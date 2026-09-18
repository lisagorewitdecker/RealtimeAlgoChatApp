#!/usr/bin/env bash
#
# Check the complete iOS native-release gate contract without changing the
# runner, booting a simulator, installing an app, or running Maestro. This is
# intended to fail fast on a prepared macOS runner.
#
# Candidate identifiers and smoke-account values are supplied by the workflow
# secret store. Never print their values from this script.
#
# This file must stay compatible with the bash 3.2 that ships with macOS.

set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "$SCRIPT_DIR" == "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="."
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_DIR" && pwd)"

PNPM_VERSION="10.26.1"
JAVA_MINIMUM_MAJOR=17
SIMULATOR_NAME="iPhone SE (3rd generation)"

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
    echo "## iOS release runner preflight"
    echo
    echo "- Status: **${status}**"
    if ((${#failures[@]})); then
      echo
      echo "### Blocking prerequisites"
      printf -- '- %s\n' "${failures[@]}"
    fi
  } >&2

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## iOS release runner preflight"
      echo
      echo "- Status: **${status}**"
      if ((${#failures[@]})); then
        echo
        echo "### Blocking prerequisites"
        printf -- '- %s\n' "${failures[@]}"
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

host_os="$(uname -s 2>/dev/null || true)"
host_arch="$(uname -m 2>/dev/null || true)"
if [[ "$host_os" != "Darwin" ]]; then
  record_failure "The iOS release runner must be macOS."
fi
if [[ "$host_arch" != "arm64" && "$host_arch" != "aarch64" && "$host_arch" != "x86_64" ]]; then
  record_failure "The iOS release runner must use arm64 or x86_64."
fi

for command in xcrun pnpm java maestro; do
  check_command "$command"
done

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version 2>/dev/null | head -n 1 || true)"
  if [[ "$pnpm_version" != "$PNPM_VERSION" ]]; then
    record_failure "Required pnpm ${PNPM_VERSION}; found ${pnpm_version:-unknown}."
  fi
fi

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
      record_failure "Could not determine the installed Java major version; Java 17 or newer is required."
    elif ((java_major < JAVA_MINIMUM_MAJOR)); then
      record_failure "Java 17 or newer is required; found Java ${java_version}."
    fi
  fi
fi

if command -v maestro >/dev/null 2>&1 &&
  ! maestro --version >/dev/null 2>&1; then
  record_failure "Maestro is installed but could not report its version."
fi

device_udid=""
booted_devices=""
simulator_check_complete=0
if command -v xcrun >/dev/null 2>&1; then
  if booted_devices="$(xcrun simctl list devices booted 2>/dev/null)"; then
    simulator_check_complete=1
    device_udid="$(
      sed -n \
        's/^[[:space:]]*iPhone SE (3rd generation) (\([0-9A-F-]\{8,\}\)) (Booted)[[:space:]]*$/\1/p' \
        <<<"$booted_devices" |
        head -n 1
    )"
  else
    record_failure "Required iOS simulator tooling is unavailable: xcrun simctl."
  fi
fi

if ((simulator_check_complete)) && [[ -z "$device_udid" ]]; then
  record_failure "A booted ${SIMULATOR_NAME} is required on the iOS runner."
fi

for value in \
  NATIVE_SMOKE_IOS_APP_ID \
  NATIVE_SMOKE_EMAIL \
  NATIVE_SMOKE_PASSWORD \
  SENTRY_AUTH_TOKEN \
  NATIVE_SMOKE_IOS_SENTRY_RELEASE \
  NATIVE_SMOKE_IOS_SENTRY_DIST \
  NATIVE_SMOKE_IOS_BUILD_ID; do
  check_environment_value "$value"
done

if [[ -n "$device_udid" && -n "${NATIVE_SMOKE_IOS_APP_ID:-}" ]] &&
  command -v xcrun >/dev/null 2>&1; then
  app_container="$(
    xcrun simctl get_app_container \
      "$device_udid" \
      "$NATIVE_SMOKE_IOS_APP_ID" \
      app 2>/dev/null || true
  )"
  if [[ -z "$app_container" || ! -f "$app_container/Info.plist" ]]; then
    record_failure "The release candidate is not installed on the prepared iOS simulator."
  elif ! LC_ALL=C grep -aR -Fq "SENTRY_RELEASE_PREFLIGHT_PASSED_V1" "$app_container"; then
    record_failure "The installed iOS candidate does not contain crash-reporting preflight evidence. Rebuild it with SENTRY_DSN or EXPO_PUBLIC_SENTRY_DSN configured."
  fi
fi

if ((${#failures[@]})); then
  echo "IOS_RELEASE_PREFLIGHT=BLOCKED" >&2
  write_summary "BLOCKED"
  exit 2
fi

echo "IOS_RELEASE_PREFLIGHT=READY"
write_summary "READY"