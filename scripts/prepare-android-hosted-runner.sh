#!/usr/bin/env bash
#
# Prepare an ephemeral GitHub-hosted Ubuntu runner for the native Android gate.
#
# The preflight and evidence jobs run on separate hosted machines, so each job
# calls this script and creates its own emulator and candidate installation.

set -euo pipefail

: "${NATIVE_SMOKE_ANDROID_BUILD_ID:?NATIVE_SMOKE_ANDROID_BUILD_ID is required.}"
: "${NATIVE_SMOKE_ANDROID_APP_ID:?NATIVE_SMOKE_ANDROID_APP_ID is required.}"
: "${EAS_TOKEN:?EAS_TOKEN is required.}"

EAS_CLI_VERSION="${EAS_CLI_VERSION:-23.2.0}"
ANDROID_API_LEVEL="${ANDROID_NATIVE_API_LEVEL:-35}"
AVD_NAME="${ANDROID_NATIVE_AVD_NAME:-native-small-api35}"
SYSTEM_IMAGE="system-images;android-${ANDROID_API_LEVEL};google_apis;x86_64"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ -z "$SDK_ROOT" || ! -d "$SDK_ROOT" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME must point to the GitHub-hosted Android SDK." >&2
  exit 2
fi

export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export PATH="$SDK_ROOT/platform-tools:$SDK_ROOT/emulator:$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/build-tools/35.0.0:$PATH"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found on the GitHub-hosted Ubuntu runner: $1" >&2
    exit 2
  fi
}

for command in adb avdmanager curl emulator find grep head pnpm sdkmanager unzip; do
  require_command "$command"
done

if ! command -v maestro >/dev/null 2>&1; then
  curl --fail --location --silent --show-error https://get.maestro.mobile.dev | bash
fi

if ! command -v maestro >/dev/null 2>&1 && [[ -d "$HOME/.maestro/bin" ]]; then
  export PATH="$HOME/.maestro/bin:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$HOME/.maestro/bin" >>"$GITHUB_PATH"
  fi
fi
require_command maestro

yes | sdkmanager --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true
sdkmanager --sdk_root="$SDK_ROOT" \
  "platform-tools" \
  "emulator" \
  "platforms;android-${ANDROID_API_LEVEL}" \
  "build-tools;35.0.0" \
  "$SYSTEM_IMAGE"

mkdir -p "$HOME/.android"
if ! avdmanager list avd | grep -q "Name: ${AVD_NAME}$"; then
  printf 'no\n' | avdmanager create avd \
    --force \
    --name "$AVD_NAME" \
    --package "$SYSTEM_IMAGE" \
    --device "pixel_2"
fi

avd_config="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
if [[ ! -f "$avd_config" ]]; then
  echo "Expected Android AVD configuration was not created: $avd_config" >&2
  exit 2
fi

set_avd_property() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$avd_config"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "$avd_config"
  else
    printf '%s=%s\n' "$key" "$value" >>"$avd_config"
  fi
}

set_avd_property "hw.lcd.width" "320"
set_avd_property "hw.lcd.height" "568"
set_avd_property "hw.lcd.density" "160"
set_avd_property "hw.initialOrientation" "Portrait"
set_avd_property "hw.gpu.mode" "swiftshader_indirect"
set_avd_property "skin.dynamic" "no"

adb start-server >/dev/null
if ! adb get-state >/dev/null 2>&1; then
  mkdir -p "$RUNNER_TEMP"
  nohup emulator \
    "@${AVD_NAME}" \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-snapshot \
    -gpu swiftshader_indirect \
    >"$RUNNER_TEMP/native-android-emulator.log" 2>&1 &
fi

timeout 180s adb wait-for-device
boot_completed=0
for _ in $(seq 1 90); do
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
    boot_completed=1
    break
  fi
  sleep 2
done
if ((boot_completed == 0)); then
  echo "The GitHub-hosted Android emulator did not finish booting." >&2
  cat "$RUNNER_TEMP/native-android-emulator.log" >&2 || true
  exit 2
fi

adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0

download_root="$RUNNER_TEMP/native-smoke-android"
rm -rf "$download_root"
mkdir -p "$download_root"
artifact_path="$download_root/candidate.apk"

EXPO_TOKEN="$EAS_TOKEN" pnpm dlx "eas-cli@${EAS_CLI_VERSION}" \
  build:download \
  --id "$NATIVE_SMOKE_ANDROID_BUILD_ID" \
  --path "$artifact_path" \
  --non-interactive

if [[ ! -f "$artifact_path" ]]; then
  echo "The EAS Android download did not produce an APK." >&2
  exit 2
fi

adb install -r "$artifact_path" >/dev/null
if ! adb shell pm path "$NATIVE_SMOKE_ANDROID_APP_ID" >/dev/null 2>&1; then
  echo "The downloaded Android candidate did not install with the configured application ID." >&2
  exit 2
fi

echo "Prepared the GitHub-hosted Android runner with the required emulator and candidate."