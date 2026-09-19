#!/usr/bin/env bash
#
# Prepare a Linux self-hosted runner for the Android native accessibility gate.
#
# This script is intentionally separate from the GitHub Actions job: SDK
# installation and emulator creation are runner administration, while the
# workflow owns release secrets and candidate verification.
#
# Usage:
#   ./scripts/provision-android-runner.sh
#   ANDROID_CMDLINE_TOOLS_SHA256=<checksum> \
#     ./scripts/provision-android-runner.sh --install-sdk
#   NATIVE_SMOKE_APK_PATH=/secure/path/candidate.apk \
#     ./scripts/provision-android-runner.sh --install-candidate
#
# The candidate APK, build ID, and smoke-account values must never be checked
# into the repository. Use the runner/GitHub environment secret store.

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "$SCRIPT_DIR" == "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="."
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_DIR" && pwd)"
# shellcheck source=android-runner-pins.sh
source "$SCRIPT_DIR/android-runner-pins.sh"

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export PATH="$HOME/.maestro/bin:$SDK_ROOT/platform-tools:$SDK_ROOT/emulator:$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/build-tools/$ANDROID_BUILD_TOOLS_VERSION:$PATH"

AVD_NAME="${ANDROID_NATIVE_AVD_NAME:-native-small-api35}"
ANDROID_API_LEVEL="${ANDROID_NATIVE_API_LEVEL:-35}"
SYSTEM_IMAGE="system-images;android-${ANDROID_API_LEVEL};google_apis;x86_64"
CMDLINE_TOOLS_URL="${ANDROID_CMDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip}"
CMDLINE_TOOLS_SHA256="${ANDROID_CMDLINE_TOOLS_SHA256:-}"
INSTALL_SDK=0
INSTALL_CANDIDATE=0
START_EMULATOR=0

usage() {
  cat >&2 <<'EOF'
Usage: provision-android-runner.sh [options]

Options:
  --install-sdk         Download pinned Android command-line tools and install
                        platform-tools, emulator, API 35, aapt2, and the small
                        AVD.
                        Requires ANDROID_CMDLINE_TOOLS_SHA256.
  --install-candidate   Install NATIVE_SMOKE_APK_PATH on the connected device.
  --start-emulator      Boot the configured native-small-api35 AVD.
  --help                Show this help.

Without an option the script verifies the existing runner installation.
EOF
}

while (($#)); do
  case "$1" in
    --install-sdk) INSTALL_SDK=1 ;;
    --install-candidate) INSTALL_CANDIDATE=1 ;;
    --start-emulator) START_EMULATOR=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This runner bootstrap supports Linux x86_64 only." >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 2
  fi
}

if ((INSTALL_SDK)); then
  require_command curl
  require_command unzip
  require_command sha256sum
  require_command java

  if [[ -z "$CMDLINE_TOOLS_SHA256" ]]; then
    echo "Set ANDROID_CMDLINE_TOOLS_SHA256 from Google's release checksum before downloading SDK tools." >&2
    exit 2
  fi

  archive="$(mktemp)"
  extract_dir="$(mktemp -d)"
  cleanup() {
    rm -f "$archive"
    rm -rf "$extract_dir"
  }
  trap cleanup EXIT

  mkdir -p "$SDK_ROOT/cmdline-tools"
  echo "Downloading Android command-line tools to a temporary file..."
  curl --fail --location --silent --show-error "$CMDLINE_TOOLS_URL" --output "$archive"
  printf '%s  %s\n' "$CMDLINE_TOOLS_SHA256" "$archive" | sha256sum --check --status
  unzip -q "$archive" -d "$extract_dir"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$extract_dir/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
fi

if ((INSTALL_SDK)); then
  require_command sdkmanager
  require_command java
else
  require_command sdkmanager
  require_command adb
  require_command avdmanager
  require_command emulator
  require_command java
fi

require_command pnpm
require_command maestro

if ((INSTALL_SDK)); then
  mkdir -p "$HOME/.android"
  yes | sdkmanager --licenses >/dev/null || true
  sdkmanager \
    "platform-tools" \
    "emulator" \
    "platforms;android-${ANDROID_API_LEVEL}" \
    "build-tools;${ANDROID_BUILD_TOOLS_VERSION}" \
    "$SYSTEM_IMAGE"

  require_command adb
  require_command avdmanager
  require_command emulator

  if ! avdmanager list avd | grep -q "Name: ${AVD_NAME}$"; then
    printf 'no\n' | avdmanager create avd \
      --name "$AVD_NAME" \
      --package "$SYSTEM_IMAGE" \
      --device "pixel_2"
  fi

  AVD_CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
  if [[ ! -f "$AVD_CONFIG" ]]; then
    echo "Expected AVD config was not created: $AVD_CONFIG" >&2
    exit 2
  fi

  # Keep the automated gate at the same smallest portrait viewport as the
  # checked-in smoke harness. These are emulator pixels at mdpi, so dp == px.
  set_avd_property() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$AVD_CONFIG"; then
      sed -i "s/^${key}=.*/${key}=${value}/" "$AVD_CONFIG"
    else
      printf '%s=%s\n' "$key" "$value" >> "$AVD_CONFIG"
    fi
  }
  set_avd_property "hw.lcd.width" "320"
  set_avd_property "hw.lcd.height" "568"
  set_avd_property "hw.lcd.density" "160"
  set_avd_property "hw.initialOrientation" "Portrait"
  set_avd_property "hw.gpu.mode" "swiftshader_indirect"
  set_avd_property "skin.dynamic" "no"
fi

if ((START_EMULATOR)); then
  AVD_CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
  if [[ ! -f "$AVD_CONFIG" ]]; then
    echo "Expected AVD config does not exist: $AVD_CONFIG (run --install-sdk first)." >&2
    exit 2
  fi
fi

require_command aapt2

if ((START_EMULATOR)); then
  require_command nohup
  if ! adb get-state >/dev/null 2>&1; then
    nohup emulator \
      "@${AVD_NAME}" \
      -no-window \
      -no-audio \
      -no-boot-anim \
      -no-snapshot \
      -gpu swiftshader_indirect \
      >"$HOME/.android/${AVD_NAME}.log" 2>&1 &
  fi
fi

if ((START_EMULATOR || INSTALL_CANDIDATE)); then
  adb wait-for-device
  adb shell settings put system accelerometer_rotation 0
  adb shell settings put system user_rotation 0
fi

if ((INSTALL_CANDIDATE)); then
  : "${NATIVE_SMOKE_APK_PATH:?Set NATIVE_SMOKE_APK_PATH to the release-candidate APK path.}"
  if [[ ! -f "$NATIVE_SMOKE_APK_PATH" ]]; then
    echo "Candidate APK does not exist: $NATIVE_SMOKE_APK_PATH" >&2
    exit 2
  fi
  adb install -r "$NATIVE_SMOKE_APK_PATH"
fi

if ((INSTALL_SDK || START_EMULATOR || INSTALL_CANDIDATE)); then
  echo "Android runner action completed for ${AVD_NAME}."
else
  echo "Android runner prerequisites verified without changing SDK or AVD state."
fi
echo "SDK: ${ANDROID_SDK_ROOT}"
echo "Run the release gate only after supplying the candidate and smoke-account secrets."