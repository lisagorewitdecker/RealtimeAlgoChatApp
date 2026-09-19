#!/usr/bin/env bash
#
# Prepare an ephemeral GitHub-hosted macOS runner for the native release gate.
#
# GitHub-hosted runners do not retain a booted simulator, installed candidate,
# or Maestro between jobs. Keep that setup here so the release workflow has the
# same explicit prerequisites on every run.

set -euo pipefail

: "${NATIVE_SMOKE_IOS_BUILD_ID:?NATIVE_SMOKE_IOS_BUILD_ID is required.}"
: "${NATIVE_SMOKE_IOS_APP_ID:?NATIVE_SMOKE_IOS_APP_ID is required.}"
: "${EAS_TOKEN:?EAS_TOKEN is required.}"

EAS_CLI_VERSION="${EAS_CLI_VERSION:-23.2.0}"
IOS_DEVICE_NAME="${IOS_NATIVE_DEVICE_NAME:-iPhone SE (3rd generation)}"
RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
MAESTRO_VERSION="${MAESTRO_VERSION:-1.39.5}"
MAESTRO_MACOS_ARM64_SHA256="${MAESTRO_MACOS_ARM64_SHA256:-REPLACE_WITH_OFFICIAL_SHA256_FOR_ARM64_ZIP}"
MAESTRO_MACOS_X64_SHA256="${MAESTRO_MACOS_X64_SHA256:-REPLACE_WITH_OFFICIAL_SHA256_FOR_X64_ZIP}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found on the GitHub-hosted macOS runner: $1" >&2
    exit 2
  fi
}

for command in curl find grep head pnpm sed shasum tar unzip xcrun; do
  require_command "$command"
done

if ! command -v maestro >/dev/null 2>&1; then
  case "$(uname -m)" in
    arm64)
      maestro_arch="arm64"
      maestro_sha256="$MAESTRO_MACOS_ARM64_SHA256"
      ;;
    x86_64)
      maestro_arch="x86_64"
      maestro_sha256="$MAESTRO_MACOS_X64_SHA256"
      ;;
    *)
      echo "Unsupported macOS architecture for Maestro install: $(uname -m)" >&2
      exit 2
      ;;
  esac

  maestro_asset="maestro-${MAESTRO_VERSION}-macos-${maestro_arch}.zip"
  maestro_url="https://github.com/mobile-dev-inc/maestro/releases/download/v${MAESTRO_VERSION}/${maestro_asset}"
  maestro_download_path="$RUNNER_TEMP/$maestro_asset"
  maestro_install_dir="$HOME/.maestro/bin"

  if [[ "$maestro_sha256" == REPLACE_WITH_OFFICIAL_SHA256_* ]]; then
    echo "Maestro checksum is not configured. Set MAESTRO_MACOS_ARM64_SHA256/MAESTRO_MACOS_X64_SHA256 to official release checksums." >&2
    exit 2
  fi

  curl --fail --location --silent --show-error --output "$maestro_download_path" "$maestro_url"
  printf '%s  %s\n' "$maestro_sha256" "$maestro_download_path" | shasum -a 256 -c -

  mkdir -p "$maestro_install_dir"
  unzip -q "$maestro_download_path" -d "$maestro_install_dir"
  chmod +x "$maestro_install_dir/maestro" || true
fi

if ! command -v maestro >/dev/null 2>&1 && [[ -d "$HOME/.maestro/bin" ]]; then
  export PATH="$HOME/.maestro/bin:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$HOME/.maestro/bin" >>"$GITHUB_PATH"
  fi
fi
require_command maestro

booted_devices="$(xcrun simctl list devices booted)"
device_udid="$(
  grep -F "$IOS_DEVICE_NAME (" <<<"$booted_devices" |
    sed -n 's/.*(\([0-9A-Fa-f-]\{8,\}\)) (Booted).*/\1/p' |
    head -n 1
)"

if [[ -z "$device_udid" ]]; then
  available_devices="$(xcrun simctl list devices available)"
  device_udid="$(
    grep -F "$IOS_DEVICE_NAME (" <<<"$available_devices" |
      sed -n 's/.*(\([0-9A-Fa-f-]\{8,\}\)) (Shutdown).*/\1/p' |
      head -n 1
  )"
  if [[ -z "$device_udid" ]]; then
    echo "GitHub-hosted macOS does not provide an available ${IOS_DEVICE_NAME} simulator." >&2
    xcrun simctl list devices available >&2
    exit 2
  fi
  xcrun simctl boot "$device_udid"
  xcrun simctl bootstatus "$device_udid" -b
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'NATIVE_SMOKE_IOS_DEVICE_UDID=%s\n' "$device_udid" >>"$GITHUB_ENV"
fi

download_root="$RUNNER_TEMP/native-smoke-ios"
rm -rf "$download_root"
mkdir -p "$download_root"
artifact_path="$download_root/candidate-artifact"

EXPO_TOKEN="$EAS_TOKEN" pnpm dlx "eas-cli@${EAS_CLI_VERSION}" \
  build:download \
  --id "$NATIVE_SMOKE_IOS_BUILD_ID" \
  --path "$artifact_path" \
  --non-interactive

app_path="$(
  find "$download_root" -type d -name '*.app' -print -quit
)"
if [[ -z "$app_path" && -f "$artifact_path" ]]; then
  extract_root="$download_root/extracted"
  mkdir -p "$extract_root"
  if unzip -t "$artifact_path" >/dev/null 2>&1; then
    unzip -q "$artifact_path" -d "$extract_root"
  elif tar -tzf "$artifact_path" >/dev/null 2>&1; then
    tar -xzf "$artifact_path" -C "$extract_root"
  fi
  app_path="$(
    find "$extract_root" -type d -name '*.app' -print -quit
  )"
fi

if [[ -z "$app_path" || ! -d "$app_path" ]]; then
  echo "The downloaded iOS candidate did not contain an installable .app bundle." >&2
  exit 2
fi

xcrun simctl install "$device_udid" "$app_path"
if ! xcrun simctl get_app_container "$device_udid" "$NATIVE_SMOKE_IOS_APP_ID" app >/dev/null 2>&1; then
  echo "The downloaded iOS candidate did not install with the configured application ID." >&2
  exit 2
fi

echo "Prepared the GitHub-hosted iOS runner with the required simulator and candidate."