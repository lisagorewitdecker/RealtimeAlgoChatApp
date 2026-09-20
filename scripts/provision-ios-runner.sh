#!/usr/bin/env bash
#
# One-command setup for the macOS self-hosted runner that executes the iOS
# native large-text release gate (.github/workflows/mobile-release.yml, job
# "native-ios").
#
# The script installs or verifies every prerequisite the job expects, boots the
# configured iOS simulator, registers the GitHub Actions runner with the exact
# labels the workflow selects, installs it as a launch agent that
# keeps running across logins, and ends with a readiness report.
#
# Usage:
#   ./scripts/provision-ios-runner.sh --dry-run     # print every action, change nothing
#   ./scripts/provision-ios-runner.sh               # install, verify, register, report
#   NATIVE_SMOKE_IOS_APP_PATH=/secure/path/candidate.tar.gz \
#     ./scripts/provision-ios-runner.sh --install-candidate
#
# The runner registration token is read from RUNNER_TOKEN, requested from an
# authenticated GitHub CLI session, or typed at a hidden prompt. It is never
# accepted as a command-line argument, never printed, and handed to config.sh
# through the ACTIONS_RUNNER_INPUT_TOKEN environment input rather than argv.
#
# Candidate bundles, build IDs, and smoke-account values must never be checked
# into the repository. Use the GitHub environment secret store.
#
# This file must stay compatible with the bash 3.2 that ships with macOS.

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
case "$SCRIPT_PATH" in
  */*) SCRIPT_DIR="$(cd -- "${SCRIPT_PATH%/*}" && pwd)" ;;
  *) SCRIPT_DIR="$(pwd)" ;;
esac
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=ios-runner-contract.sh
source "$SCRIPT_DIR/ios-runner-contract.sh"

# Pinned GitHub Actions runner release. Update the version and both digests
# together, and keep them in step with the Linux procedure in
# artifacts/chat-app/docs/native-large-text-device-check.md.
RUNNER_VERSION="2.337.0"
RUNNER_SHA256_OSX_ARM64="5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2"
RUNNER_SHA256_OSX_X64="d383f505d7ed041b1873ab68c35dd766fc093f2252330f95bb427be8f2c6dcfc"

# Toolchain the workflow's iOS job expects on the host.
NODE_MAJOR_VERSION="24"

# Runner identity. The labels must match the native-ios job's runs-on list.
RUNNER_LABELS="self-hosted,macos,ios,smallest-simulator"
RUNNER_NAME="${RUNNER_NAME:-ios-release-mac}"
RUNNER_ROOT="${RUNNER_ROOT:-$HOME/actions-runner}"
RUNNER_WORK_DIR="_work"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-lisagorewitdecker/RealtimeAlgoChatApp}"
GITHUB_ENVIRONMENT="mobile-release"

SIMULATOR_AGENT_LABEL="actions.runner.${GITHUB_REPOSITORY//\//-}.ios-release-simulator"
SIMULATOR_AGENT_PLIST="$HOME/Library/LaunchAgents/${SIMULATOR_AGENT_LABEL}.plist"

# GitHub configuration the native-ios job reads. Names only; the script never
# handles the values.
IOS_JOB_ENVIRONMENT_SECRETS="$IOS_RUNNER_REQUIRED_ENVIRONMENT_VALUES"
IOS_JOB_OPTIONAL_SECRETS="NATIVE_SMOKE_DISPLAY_NAME"
IOS_JOB_REPOSITORY_VARIABLES="$IOS_RUNNER_REQUIRED_REPOSITORY_VARIABLES"

DRY_RUN=0
INSTALL_CANDIDATE=0
CHECK_GITHUB=0
NO_GITHUB=0
SKIP_REGISTRATION=0

usage() {
  cat >&2 <<'EOF'
Usage: provision-ios-runner.sh [options]

Options:
  --dry-run             Print every action without changing anything.
  --install-candidate   Install NATIVE_SMOKE_IOS_APP_PATH (a .app bundle or an
                        EAS simulator .tar.gz) on the booted simulator.
  --check-github        Query GitHub for the runner status and the configured
                        secret and variable names without prompting.
  --no-github           Never call the GitHub CLI, even when it is authenticated.
  --skip-registration   Prepare the host only; do not register or start the runner.
  --help                Show this help.

Environment:
  RUNNER_TOKEN              Registration token (never pass it as an argument).
  RUNNER_NAME               Runner name (default: ios-release-mac).
  RUNNER_ROOT               Runner directory (default: ~/actions-runner).
  GITHUB_REPOSITORY         owner/repo to register with.
  NATIVE_SMOKE_IOS_APP_ID   Bundle identifier used to verify an installed candidate.
  NATIVE_SMOKE_IOS_APP_PATH Candidate bundle for --install-candidate.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --install-candidate) INSTALL_CANDIDATE=1 ;;
    --check-github) CHECK_GITHUB=1 ;;
    --no-github) NO_GITHUB=1 ;;
    --skip-registration) SKIP_REGISTRATION=1 ;;
    --help|-h) usage; exit 0 ;;
    --token|--token=*|--pat|--pat=*)
      echo "The registration token is never accepted on the command line. Export RUNNER_TOKEN, authenticate the GitHub CLI, or wait for the hidden prompt." >&2
      exit 2
      ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if ((CHECK_GITHUB && NO_GITHUB)); then
  echo "--check-github and --no-github cannot be combined." >&2
  exit 2
fi

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
IS_MACOS=0
if [[ "$HOST_OS" == "Darwin" ]]; then
  IS_MACOS=1
fi

if ((!IS_MACOS && !DRY_RUN)); then
  echo "This runner bootstrap supports macOS only. Use --dry-run to preview the actions on ${HOST_OS}." >&2
  exit 2
fi

case "$HOST_ARCH" in
  arm64|aarch64)
    RUNNER_ARCH="arm64"
    RUNNER_SHA256="$RUNNER_SHA256_OSX_ARM64"
    ;;
  x86_64)
    RUNNER_ARCH="x64"
    RUNNER_SHA256="$RUNNER_SHA256_OSX_X64"
    ;;
  *)
    echo "Unsupported architecture for the macOS runner: ${HOST_ARCH}" >&2
    exit 2
    ;;
esac

if ((IS_MACOS)); then
  HOST_DESCRIPTION="macOS $(sw_vers -productVersion 2>/dev/null || echo unknown) (${HOST_ARCH})"
  DEFAULT_PLAYWRIGHT_CACHE="$HOME/Library/Caches/ms-playwright"
else
  HOST_DESCRIPTION="${HOST_OS} (${HOST_ARCH}); dry run only, macOS-only checks skipped"
  DEFAULT_PLAYWRIGHT_CACHE="$HOME/.cache/ms-playwright"
fi
SKIP_DETAIL="macOS only; skipped during this dry run on ${HOST_OS}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
have() { command -v "$1" >/dev/null 2>&1; }
is_interactive() { [[ -t 0 && -t 1 ]]; }

# run_action <description> <command...>
# Prints the description; in dry-run mode nothing else happens.
run_action() {
  local description="$1"
  shift
  if ((DRY_RUN)); then
    log "[dry-run] ${description}"
    return 0
  fi
  log "$description"
  "$@"
}

# plan <description>: an action that cannot run yet (a missing installer) but
# should still appear in the dry-run transcript.
plan() {
  if ((DRY_RUN)); then
    log "[dry-run] $1"
  fi
}

TEMP_PATHS=()
cleanup() {
  if ((${#TEMP_PATHS[@]})); then
    rm -rf "${TEMP_PATHS[@]}"
  fi
}
trap cleanup EXIT

ROW_NAMES=()
ROW_STATUSES=()
ROW_DETAILS=()
CORE_READY=1

# record <name> <READY|MISSING|SKIPPED> <detail> [core]
# "core" rows gate runner registration: GitHub must never route the iOS job to
# a Mac that cannot run it.
record() {
  ROW_NAMES+=("$1")
  ROW_STATUSES+=("$2")
  ROW_DETAILS+=("$3")
  log "  [$2] $1: $3"
  if [[ "${4:-}" == "core" && "$2" != "READY" ]]; then
    CORE_READY=0
  fi
}

version_from_output() {
  # Prints the first dotted version number found in stdin.
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done
  return 0
}

BREW_PREFIX=""
NODE_BIN_DIR=""
JAVA_BIN_DIR=""
JAVA_HOME_DIR=""
XCODE_READY=0
SIMULATOR_RUNTIME="${IOS_RUNNER_SIMULATOR_RUNTIME:-}"
SIMULATOR_UDID=""
ENVIRONMENT_CHANGED=0
REGISTRATION_TOKEN=""
# Set once this run registered the runner or verified an existing registration
# (repository, name, and labels). The service is never installed or started
# for anything else.
REGISTRATION_VERIFIED=0
# Dry run only: registration would happen, so the service steps are planned.
REGISTRATION_PLANNED=0

# ---------------------------------------------------------------------------
# Xcode and simulator runtime
# ---------------------------------------------------------------------------

XCODE_FIX="install Xcode from the App Store, then run: sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept && xcodebuild -runFirstLaunch"

# simctl's text listing may pad lines with trailing whitespace, so the runtime
# and device patterns end with [[:space:]]* rather than anchoring to the value.
latest_ios_runtime() {
  xcrun simctl list runtimes available 2>/dev/null |
    sed -n 's/^iOS .* - \(com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9][0-9-]*\)[[:space:]]*$/\1/p' |
    tail -n 1
}

check_xcode() {
  step "Xcode and simulator tooling"
  if ((!IS_MACOS)); then
    plan "verify Xcode with simctl: xcode-select -p && xcrun simctl list devices"
    plan "download the iOS simulator runtime when none is available: xcodebuild -downloadPlatform iOS"
    record "Xcode with simctl" SKIPPED "$SKIP_DETAIL" core
    record "iOS simulator runtime" SKIPPED "$SKIP_DETAIL" core
    return 0
  fi

  local developer_dir
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ -z "$developer_dir" ]]; then
    record "Xcode with simctl" MISSING "$XCODE_FIX" core
    record "iOS simulator runtime" MISSING "requires Xcode" core
    return 0
  fi
  if ! xcrun simctl list devices >/dev/null 2>&1; then
    record "Xcode with simctl" MISSING "${developer_dir} does not provide simctl (Command Line Tools alone are not enough); ${XCODE_FIX}" core
    record "iOS simulator runtime" MISSING "requires Xcode" core
    return 0
  fi
  XCODE_READY=1
  record "Xcode with simctl" READY "$developer_dir" core

  if [[ -z "$SIMULATOR_RUNTIME" ]]; then
    SIMULATOR_RUNTIME="$(latest_ios_runtime)"
  fi
  if [[ -z "$SIMULATOR_RUNTIME" ]]; then
    run_action "download the current iOS simulator runtime: xcodebuild -downloadPlatform iOS" \
      xcodebuild -downloadPlatform iOS || true
    SIMULATOR_RUNTIME="$(latest_ios_runtime)"
  fi
  if [[ -n "$SIMULATOR_RUNTIME" ]]; then
    record "iOS simulator runtime" READY "$SIMULATOR_RUNTIME" core
  else
    record "iOS simulator runtime" MISSING "run: xcodebuild -downloadPlatform iOS (or Xcode > Settings > Components)" core
  fi
}

# ---------------------------------------------------------------------------
# Homebrew, Node.js, pnpm, Java, Maestro, Playwright
# ---------------------------------------------------------------------------

install_homebrew() {
  /bin/bash -c "$(curl --fail --location --silent --show-error https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

check_homebrew() {
  step "Homebrew"
  if ((!IS_MACOS)); then
    plan "install Homebrew when it is missing (interactive, asks for your password): /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    record "Homebrew" SKIPPED "$SKIP_DETAIL"
    return 0
  fi

  local brew_bin="" candidate
  for candidate in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      brew_bin="$candidate"
      break
    fi
  done
  if [[ -z "$brew_bin" ]]; then
    if is_interactive || ((DRY_RUN)); then
      if run_action "install Homebrew with the official installer (asks for your password): /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" install_homebrew; then
        for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
          if [[ -x "$candidate" ]]; then
            brew_bin="$candidate"
            break
          fi
        done
      fi
    fi
  fi
  if [[ -z "$brew_bin" ]]; then
    record "Homebrew" MISSING "install from https://brew.sh in an interactive Terminal, then re-run this script"
    return 0
  fi
  eval "$("$brew_bin" shellenv)"
  BREW_PREFIX="$("$brew_bin" --prefix)"
  record "Homebrew" READY "$brew_bin"
}

# attempt_brew_install <formula>: installs through Homebrew when it is
# available; otherwise only plans the action.
attempt_brew_install() {
  if [[ -n "$BREW_PREFIX" ]]; then
    run_action "install $1: brew install $1" brew install "$1"
  else
    plan "install $1 once Homebrew is available: brew install $1"
    return 1
  fi
}

check_node() {
  step "Node.js ${NODE_MAJOR_VERSION}"
  local node_bin="" version=""
  if have node; then
    version="$(node --version 2>/dev/null || true)"
    if [[ "$version" == "v${NODE_MAJOR_VERSION}."* ]]; then
      node_bin="$(command -v node)"
    fi
  fi
  if [[ -z "$node_bin" ]]; then
    local keg="${BREW_PREFIX:+$BREW_PREFIX/opt/node@${NODE_MAJOR_VERSION}}"
    if [[ -z "$keg" || ! -x "$keg/bin/node" ]]; then
      attempt_brew_install "node@${NODE_MAJOR_VERSION}" || true
    fi
    if [[ -n "$keg" && -x "$keg/bin/node" ]]; then
      export PATH="$keg/bin:$PATH"
      node_bin="$keg/bin/node"
      version="$("$node_bin" --version 2>/dev/null || true)"
    fi
  fi
  if [[ -n "$node_bin" ]]; then
    NODE_BIN_DIR="${node_bin%/*}"
    record "Node.js ${NODE_MAJOR_VERSION}" READY "${version} (${node_bin})"
  else
    record "Node.js ${NODE_MAJOR_VERSION}" MISSING "found ${version:-none}; expected v${NODE_MAJOR_VERSION}.x (brew install node@${NODE_MAJOR_VERSION})"
  fi
}

pnpm_version() {
  if have pnpm; then
    (cd "$HOME" && pnpm --version 2>/dev/null) || true
  fi
}

activate_pnpm() {
  corepack enable pnpm && corepack prepare "pnpm@${IOS_RUNNER_PNPM_VERSION}" --activate
}

check_pnpm() {
  step "pnpm ${IOS_RUNNER_PNPM_VERSION}"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  local found
  found="$(pnpm_version)"
  if [[ "$found" != "$IOS_RUNNER_PNPM_VERSION" ]]; then
    local activation="activate pnpm ${IOS_RUNNER_PNPM_VERSION} through corepack: corepack enable pnpm && corepack prepare pnpm@${IOS_RUNNER_PNPM_VERSION} --activate"
    if have corepack; then
      run_action "$activation" activate_pnpm || true
    elif have npm; then
      run_action "install corepack (recent Node.js releases omit it): npm install -g corepack" npm install -g corepack || true
      if have corepack; then
        run_action "$activation" activate_pnpm || true
      fi
    else
      plan "$activation (after Node.js ${NODE_MAJOR_VERSION} is installed)"
    fi
    hash -r 2>/dev/null || true
    found="$(pnpm_version)"
  fi
  if [[ "$found" == "$IOS_RUNNER_PNPM_VERSION" ]]; then
    record "pnpm ${IOS_RUNNER_PNPM_VERSION}" READY "$(command -v pnpm)" core
  else
    record "pnpm ${IOS_RUNNER_PNPM_VERSION}" MISSING "found ${found:-none}; expected ${IOS_RUNNER_PNPM_VERSION} (corepack prepare pnpm@${IOS_RUNNER_PNPM_VERSION} --activate)" core
  fi
}

java_major() {
  # Prints the major version reported by the java binary $1, or nothing.
  local output
  output="$("$1" -version 2>&1 || true)"
  if [[ "$output" =~ version[[:space:]]\"([0-9]+)(\.[0-9]+)* ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

check_java() {
  step "Java ${IOS_RUNNER_JAVA_MINIMUM_MAJOR} or newer"
  local java_bin="" major=""

  if ((IS_MACOS)) && [[ -x /usr/libexec/java_home ]]; then
    local home
    home="$(/usr/libexec/java_home -v "${IOS_RUNNER_JAVA_MINIMUM_MAJOR}+" 2>/dev/null || true)"
    if [[ -n "$home" && -x "$home/bin/java" ]]; then
      java_bin="$home/bin/java"
      JAVA_HOME_DIR="$home"
    fi
  fi
  if [[ -z "$java_bin" && -n "$BREW_PREFIX" ]]; then
    local keg="$BREW_PREFIX/opt/openjdk@${IOS_RUNNER_JAVA_MINIMUM_MAJOR}"
    if [[ ! -x "$keg/bin/java" ]]; then
      attempt_brew_install "openjdk@${IOS_RUNNER_JAVA_MINIMUM_MAJOR}" || true
    fi
    if [[ -x "$keg/bin/java" ]]; then
      java_bin="$keg/bin/java"
      JAVA_HOME_DIR="$keg/libexec/openjdk.jdk/Contents/Home"
    fi
  fi
  if [[ -z "$java_bin" ]] && have java; then
    major="$(java_major java)"
    if [[ -n "$major" && "$major" -ge "$IOS_RUNNER_JAVA_MINIMUM_MAJOR" ]]; then
      java_bin="$(command -v java)"
      JAVA_HOME_DIR="${JAVA_HOME:-$(cd -- "${java_bin%/*}/.." && pwd)}"
    fi
  fi
  if [[ -z "$java_bin" && -z "$BREW_PREFIX" ]]; then
    attempt_brew_install "openjdk@${IOS_RUNNER_JAVA_MINIMUM_MAJOR}" || true
  fi

  if [[ -n "$java_bin" ]]; then
    major="$(java_major "$java_bin")"
    JAVA_BIN_DIR="${java_bin%/*}"
    export JAVA_HOME="$JAVA_HOME_DIR"
    export PATH="$JAVA_BIN_DIR:$PATH"
    record "Java ${IOS_RUNNER_JAVA_MINIMUM_MAJOR} or newer" READY "Java ${major:-?} (${java_bin})" core
  else
    record "Java ${IOS_RUNNER_JAVA_MINIMUM_MAJOR} or newer" MISSING "found ${major:-none}; brew install openjdk@${IOS_RUNNER_JAVA_MINIMUM_MAJOR}" core
  fi
}

install_maestro() {
  curl --fail --location --silent --show-error https://get.maestro.mobile.dev | bash
}

check_maestro() {
  step "Maestro"
  export PATH="$HOME/.maestro/bin:$PATH"
  export MAESTRO_CLI_NO_ANALYTICS=1
  if ! have maestro; then
    run_action "install Maestro: curl -fsSL https://get.maestro.mobile.dev | bash" install_maestro || true
    hash -r 2>/dev/null || true
  fi
  if have maestro; then
    local version
    version="$(maestro --version 2>/dev/null | version_from_output || true)"
    if [[ -n "$version" ]]; then
      record "Maestro" READY "${version} ($(command -v maestro))" core
    else
      record "Maestro" MISSING "$(command -v maestro) is installed but 'maestro --version' failed (check Java)" core
    fi
  else
    record "Maestro" MISSING "install with the official installer: bash -c \"\$(curl -fsSL https://get.maestro.mobile.dev)\"" core
  fi
}

check_shared_release_commands() {
  step "Shared iOS release tools"
  if ((!IS_MACOS)); then
    plan "verify the shared iOS release commands: ${IOS_RUNNER_REQUIRED_COMMANDS}"
    return 0
  fi

  local command missing=""
  for command in $IOS_RUNNER_REQUIRED_COMMANDS; do
    if ! have "$command"; then
      if [[ -n "$missing" ]]; then
        missing="${missing}, "
      fi
      missing="${missing}${command}"
    fi
  done
  if [[ -n "$missing" ]]; then
    record "Shared iOS release tools" MISSING "missing: ${missing}" core
  else
    record "Shared iOS release tools" READY "$IOS_RUNNER_REQUIRED_COMMANDS" core
  fi
}

playwright_version() {
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ \"@playwright/test\":[[:space:]]*\"([^\"]+)\" ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <"$WORKSPACE_ROOT/artifacts/api-server/package.json"
  return 0
}

playwright_chromium_installed() {
  local directory
  for directory in "$1"/chromium-*; do
    if [[ -d "$directory" ]]; then
      return 0
    fi
  done
  return 1
}

check_playwright() {
  step "Playwright Chromium (the iOS gate also runs a browser check)"
  local version cache
  version="$(playwright_version)"
  cache="${PLAYWRIGHT_BROWSERS_PATH:-$DEFAULT_PLAYWRIGHT_CACHE}"
  if [[ -z "$version" ]]; then
    record "Playwright Chromium" MISSING "could not read the @playwright/test version from artifacts/api-server/package.json"
    return 0
  fi
  if ! playwright_chromium_installed "$cache"; then
    local action="install Chromium for Playwright ${version}: pnpm dlx playwright@${version} install chromium"
    if have pnpm; then
      run_action "$action" pnpm dlx "playwright@${version}" install chromium || true
    else
      plan "$action (after pnpm is available)"
    fi
  fi
  if playwright_chromium_installed "$cache"; then
    record "Playwright Chromium" READY "$cache"
  else
    record "Playwright Chromium" MISSING "pnpm dlx playwright@${version} install chromium"
  fi
}

# ---------------------------------------------------------------------------
# Simulator
# ---------------------------------------------------------------------------

# find_simulator_udid <state pattern>: mirrors the workflow's own match
# (including its tolerance for trailing whitespace after the state).
find_simulator_udid() {
  xcrun simctl list devices available 2>/dev/null |
    sed -n 's/^[[:space:]]*'"$IOS_RUNNER_SIMULATOR_NAME"' (\([0-9A-F-]\{8,\}\)) ('"$1"')[[:space:]]*$/\1/p' |
    tail -n 1
}

boot_simulator() {
  xcrun simctl boot "$1" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$1" -b
}

# simulator_agent_command <udid>: the login agent's shell command. It issues
# simctl boot itself (a no-op error when the device is already booted, hence
# the ';') and then waits for the boot to finish; bootstatus alone would only
# monitor a device that something else booted.
simulator_agent_command() {
  printf '/usr/bin/xcrun simctl boot %s; exec /usr/bin/xcrun simctl bootstatus %s -b' "$1" "$1"
}

simulator_agent_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SIMULATOR_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$(simulator_agent_command "$1")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/${SIMULATOR_AGENT_LABEL}.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/${SIMULATOR_AGENT_LABEL}.log</string>
</dict>
</plist>
EOF
}

# write_simulator_agent <plist content>: replaces the agent and loads it.
# launchctl bootout finishes asynchronously, so an immediate bootstrap can
# still see the old registration ("Bootstrap failed: 5: Input/output error");
# the load is retried briefly before it is reported as a failure.
SIMULATOR_AGENT_LOAD_ATTEMPTS="${IOS_RUNNER_AGENT_LOAD_ATTEMPTS:-5}"

write_simulator_agent() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" || return 1
  printf '%s\n' "$1" >"$SIMULATOR_AGENT_PLIST" || return 1
  local domain="gui/$(id -u)" attempt=1 output=""
  launchctl bootout "${domain}/${SIMULATOR_AGENT_LABEL}" >/dev/null 2>&1 || true
  while :; do
    if output="$(launchctl bootstrap "$domain" "$SIMULATOR_AGENT_PLIST" 2>&1)"; then
      return 0
    fi
    if ((attempt >= SIMULATOR_AGENT_LOAD_ATTEMPTS)); then
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
}

ensure_simulator_agent() {
  local content
  content="$(simulator_agent_plist "$SIMULATOR_UDID")"
  if [[ -f "$SIMULATOR_AGENT_PLIST" && "$(<"$SIMULATOR_AGENT_PLIST")" == "$content" ]]; then
    record "Simulator boot launch agent" READY "$SIMULATOR_AGENT_PLIST"
    return 0
  fi
  if run_action "write ${SIMULATOR_AGENT_PLIST} so '${IOS_RUNNER_SIMULATOR_NAME}' boots at every login, then load it: launchctl bootstrap gui/\$(id -u) ${SIMULATOR_AGENT_PLIST}" write_simulator_agent "$content"; then
    if ((DRY_RUN)); then
      record "Simulator boot launch agent" MISSING "will be written to ${SIMULATOR_AGENT_PLIST}"
    else
      record "Simulator boot launch agent" READY "$SIMULATOR_AGENT_PLIST"
    fi
  else
    record "Simulator boot launch agent" MISSING "could not load ${SIMULATOR_AGENT_PLIST}; run this script from the logged-in desktop session, not over SSH"
  fi
}

check_simulator() {
  step "${IOS_RUNNER_SIMULATOR_NAME} simulator"
  if ((!IS_MACOS)); then
    plan "locate '${IOS_RUNNER_SIMULATOR_NAME}', create it from ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} on the newest available iOS runtime when absent, and boot it: xcrun simctl boot <udid> && xcrun simctl bootstatus <udid> -b"
    plan "write ${SIMULATOR_AGENT_PLIST} so the simulator boots at every login"
    record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" SKIPPED "$SKIP_DETAIL" core
    record "Simulator boot launch agent" SKIPPED "$SKIP_DETAIL"
    return 0
  fi
  if ((!XCODE_READY)); then
    record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" MISSING "requires Xcode with simctl" core
    record "Simulator boot launch agent" MISSING "written after the simulator is booted"
    return 0
  fi

  local udid create_error="" create_stderr
  udid="$(find_simulator_udid Booted)"
  if [[ -z "$udid" ]]; then
    udid="$(find_simulator_udid '[A-Za-z ]*')"
    if [[ -z "$udid" ]]; then
      if [[ -n "$SIMULATOR_RUNTIME" ]]; then
        if ((DRY_RUN)); then
          log "[dry-run] create '${IOS_RUNNER_SIMULATOR_NAME}': xcrun simctl create \"${IOS_RUNNER_SIMULATOR_NAME}\" ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} ${SIMULATOR_RUNTIME}"
        else
          log "Creating '${IOS_RUNNER_SIMULATOR_NAME}' on ${SIMULATOR_RUNTIME}..."
          # simctl's reason for refusing (for example a device type that the
          # installed Xcode no longer offers) belongs in the report row.
          create_stderr="$(mktemp)"
          udid="$(xcrun simctl create "$IOS_RUNNER_SIMULATOR_NAME" "$IOS_RUNNER_SIMULATOR_DEVICE_TYPE" "$SIMULATOR_RUNTIME" 2>"$create_stderr" || true)"
          if [[ -z "$udid" ]]; then
            create_error="$(tr '\n' ' ' <"$create_stderr" | sed 's/[[:space:]]*$//')"
            log "simctl create failed${create_error:+: ${create_error}}"
          fi
          rm -f "$create_stderr"
        fi
      fi
    fi
    if [[ -n "$udid" ]]; then
      run_action "boot ${IOS_RUNNER_SIMULATOR_NAME} (${udid}): xcrun simctl boot ${udid} && xcrun simctl bootstatus ${udid} -b" boot_simulator "$udid" || true
    elif ((DRY_RUN)); then
      plan "boot the created simulator: xcrun simctl boot <udid> && xcrun simctl bootstatus <udid> -b"
    fi
  fi

  SIMULATOR_UDID="$(find_simulator_udid Booted)"
  if [[ -n "$SIMULATOR_UDID" ]]; then
    record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" READY "$SIMULATOR_UDID" core
    ensure_simulator_agent
  else
    if ((DRY_RUN)) && [[ -n "$udid" ]]; then
      record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" MISSING "will be booted (${udid})" core
    elif ((DRY_RUN)); then
      record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" MISSING "will be created on ${SIMULATOR_RUNTIME:-an iOS runtime} and booted" core
    elif [[ -n "$create_error" ]]; then
      record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" MISSING "xcrun simctl create ${IOS_RUNNER_SIMULATOR_DEVICE_TYPE} on ${SIMULATOR_RUNTIME} failed: ${create_error}" core
    else
      record "Booted ${IOS_RUNNER_SIMULATOR_NAME}" MISSING "no booted '${IOS_RUNNER_SIMULATOR_NAME}'; check 'xcrun simctl list devices available' and the runtime row above" core
    fi
    record "Simulator boot launch agent" MISSING "written after the simulator is booted"
  fi
}

# ---------------------------------------------------------------------------
# Release candidate
# ---------------------------------------------------------------------------

resolve_app_bundle() {
  # Prints the .app directory for NATIVE_SMOKE_IOS_APP_PATH, extracting an EAS
  # simulator tarball when needed.
  local source="$1"
  case "$source" in
    *.app)
      if [[ -d "$source" ]]; then
        printf '%s\n' "$source"
        return 0
      fi
      ;;
    *.tar.gz|*.tgz)
      local extract_dir
      extract_dir="$(mktemp -d)"
      TEMP_PATHS+=("$extract_dir")
      tar -xzf "$source" -C "$extract_dir"
      find "$extract_dir" -maxdepth 2 -type d -name '*.app' | head -n 1
      return 0
      ;;
  esac
  return 1
}

install_candidate_bundle() {
  local bundle
  bundle="$(resolve_app_bundle "$NATIVE_SMOKE_IOS_APP_PATH")"
  if [[ -z "$bundle" ]]; then
    warn "NATIVE_SMOKE_IOS_APP_PATH must be a .app bundle or a .tar.gz containing one."
    return 1
  fi
  CANDIDATE_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Info.plist" 2>/dev/null || true)"
  xcrun simctl install "$SIMULATOR_UDID" "$bundle"
}

check_candidate() {
  step "Release candidate on the simulator"
  CANDIDATE_BUNDLE_ID="${!IOS_RUNNER_CANDIDATE_APP_ID_ENVIRONMENT_VALUE:-}"
  if ((INSTALL_CANDIDATE)); then
    if [[ -z "${NATIVE_SMOKE_IOS_APP_PATH:-}" ]]; then
      die "Set NATIVE_SMOKE_IOS_APP_PATH to the candidate .app bundle or EAS simulator .tar.gz before using --install-candidate."
    fi
    if [[ ! -e "$NATIVE_SMOKE_IOS_APP_PATH" ]]; then
      die "Candidate does not exist: ${NATIVE_SMOKE_IOS_APP_PATH}"
    fi
  fi
  if ((!IS_MACOS)); then
    if ((INSTALL_CANDIDATE)); then
      plan "install the candidate from NATIVE_SMOKE_IOS_APP_PATH: xcrun simctl install <udid> <candidate.app>"
    fi
    plan "verify the installed candidate: xcrun simctl get_app_container <udid> <bundle id> app, then confirm the crash-reporting preflight marker"
    record "Release candidate installed" SKIPPED "$SKIP_DETAIL"
    return 0
  fi
  if [[ -z "$SIMULATOR_UDID" ]]; then
    record "Release candidate installed" MISSING "requires the booted simulator"
    return 0
  fi
  if ((INSTALL_CANDIDATE)); then
    run_action "install the candidate from NATIVE_SMOKE_IOS_APP_PATH on ${SIMULATOR_UDID}: xcrun simctl install ${SIMULATOR_UDID} <candidate.app>" install_candidate_bundle || true
  fi
  if [[ -z "$CANDIDATE_BUNDLE_ID" ]]; then
    record "Release candidate installed" MISSING "not verified: export ${IOS_RUNNER_CANDIDATE_APP_ID_ENVIRONMENT_VALUE} (the bundle identifier) or use --install-candidate"
    return 0
  fi
  local container
  container="$(xcrun simctl get_app_container "$SIMULATOR_UDID" "$CANDIDATE_BUNDLE_ID" app 2>/dev/null || true)"
  if [[ -z "$container" || ! -f "$container/Info.plist" ]]; then
    record "Release candidate installed" MISSING "not installed on ${SIMULATOR_UDID}; use --install-candidate with NATIVE_SMOKE_IOS_APP_PATH"
    return 0
  fi
  if ! LC_ALL=C grep -aR -Fq "$IOS_RUNNER_CANDIDATE_PREFLIGHT_MARKER" "$container"; then
    record "Release candidate installed" MISSING "installed, but it lacks crash-reporting preflight evidence; rebuild with SENTRY_DSN or EXPO_PUBLIC_SENTRY_DSN configured"
    return 0
  fi
  record "Release candidate installed" READY "installed on ${SIMULATOR_UDID} with crash-reporting preflight evidence"
}

# ---------------------------------------------------------------------------
# GitHub Actions runner
# ---------------------------------------------------------------------------

verify_sha256() {
  if have shasum; then
    printf '%s  %s\n' "$1" "$2" | shasum -a 256 --check --status
  elif have sha256sum; then
    printf '%s  %s\n' "$1" "$2" | sha256sum --check --status
  else
    warn "Neither shasum nor sha256sum is available to verify the runner archive."
    return 1
  fi
}

# install_runner_package <url>
# Every step short-circuits explicitly: this function is called from an if
# condition, where bash suppresses errexit, and the archive must never be
# extracted unless its digest matched.
install_runner_package() {
  local url="$1" archive
  mkdir -p "$RUNNER_ROOT" || return 1
  archive="$(mktemp)" || return 1
  TEMP_PATHS+=("$archive")
  if ! curl --fail --location --silent --show-error "$url" --output "$archive"; then
    warn "Download failed: ${url}"
    return 1
  fi
  if ! verify_sha256 "$RUNNER_SHA256" "$archive"; then
    warn "SHA-256 mismatch for ${url}; the archive was discarded and nothing was extracted."
    return 1
  fi
  tar -xzf "$archive" -C "$RUNNER_ROOT" || return 1
}

check_runner_package() {
  step "GitHub Actions runner ${RUNNER_VERSION}"
  local asset="actions-runner-osx-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
  local url="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${asset}"
  if [[ -f "$RUNNER_ROOT/config.sh" ]]; then
    local installed=""
    if ((IS_MACOS)) && [[ -x "$RUNNER_ROOT/bin/Runner.Listener" ]]; then
      installed="$("$RUNNER_ROOT/bin/Runner.Listener" --version 2>/dev/null | version_from_output || true)"
    fi
    record "GitHub Actions runner ${RUNNER_VERSION}" READY "${RUNNER_ROOT} (installed ${installed:-unknown version}; pinned ${RUNNER_VERSION}, self-updates)"
    return 0
  fi
  if run_action "download ${url} to a temporary file, verify SHA-256 ${RUNNER_SHA256}, and extract it into ${RUNNER_ROOT}" install_runner_package "$url"; then
    if ((DRY_RUN)); then
      record "GitHub Actions runner ${RUNNER_VERSION}" MISSING "will be installed into ${RUNNER_ROOT} from ${asset}"
    else
      record "GitHub Actions runner ${RUNNER_VERSION}" READY "${RUNNER_ROOT} (${RUNNER_VERSION})"
    fi
  else
    record "GitHub Actions runner ${RUNNER_VERSION}" MISSING "download or checksum verification failed for ${asset}"
  fi
}

gh_authenticated() {
  ((!NO_GITHUB)) && have gh && gh auth status >/dev/null 2>&1
}

obtain_registration_token() {
  REGISTRATION_TOKEN="${RUNNER_TOKEN:-}"
  if [[ -n "$REGISTRATION_TOKEN" ]]; then
    log "Using the registration token from RUNNER_TOKEN."
    return 0
  fi
  if gh_authenticated; then
    log "Requesting a short-lived registration token through the GitHub CLI..."
    REGISTRATION_TOKEN="$(gh api --method POST "repos/${GITHUB_REPOSITORY}/actions/runners/registration-token" --jq .token 2>/dev/null || true)"
    if [[ -n "$REGISTRATION_TOKEN" ]]; then
      return 0
    fi
    warn "The GitHub CLI could not create a registration token (it needs repository admin access)."
  fi
  if is_interactive; then
    log "Create a token at https://github.com/${GITHUB_REPOSITORY}/settings/actions/runners/new?arch=${RUNNER_ARCH}&os=osx and copy only the value shown after --token."
    if ! read -r -s -p "Registration token (input hidden): " REGISTRATION_TOKEN; then
      REGISTRATION_TOKEN=""
    fi
    printf '\n'
    if [[ -n "$REGISTRATION_TOKEN" ]]; then
      return 0
    fi
  fi
  return 1
}

# The token reaches config.sh through the runner's ACTIONS_RUNNER_INPUT_TOKEN
# environment input (the runner reads and clears it) instead of --token, so it
# never appears in a process argument list.
configure_runner() {
  (
    cd "$RUNNER_ROOT" &&
      ACTIONS_RUNNER_INPUT_TOKEN="$REGISTRATION_TOKEN" ./config.sh \
        --unattended \
        --url "https://github.com/${GITHUB_REPOSITORY}" \
        --name "$RUNNER_NAME" \
        --labels "$RUNNER_LABELS" \
        --work "$RUNNER_WORK_DIR" \
        --replace
  )
}

# runner_json_value <key>: prints the string or numeric value stored for <key>
# in the runner's .runner registration record, or nothing.
runner_json_value() {
  local line
  if [[ -f "$RUNNER_ROOT/.runner" ]]; then
    while IFS= read -r line; do
      if [[ "$line" =~ \"$1\":[[:space:]]*\"([^\"]*)\" ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
        return 0
      fi
      if [[ "$line" =~ \"$1\":[[:space:]]*([0-9]+) ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
        return 0
      fi
    done <"$RUNNER_ROOT/.runner"
  fi
  return 0
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# github_runner_labels: prints the comma-separated labels GitHub reports for
# RUNNER_NAME, or nothing when the runner is unknown to the repository.
github_runner_labels() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runners" --paginate \
    --jq ".runners[] | select(.name == \"${RUNNER_NAME}\") | [.labels[].name] | join(\",\")" 2>/dev/null | head -n 1 || true
}

# missing_labels <reported labels>: prints the expected labels absent from the
# reported, comma-separated list (GitHub label names are case-insensitive).
missing_labels() {
  local reported expected missing="" label
  reported=",$(lowercase "$1"),"
  for expected in ${RUNNER_LABELS//,/ }; do
    label="$(lowercase "$expected")"
    case "$reported" in
      *",${label},"*) ;;
      *) missing="${missing:+${missing},}${expected}" ;;
    esac
  done
  printf '%s\n' "$missing"
}

# The registration record remembers which registration this script created
# (the runner's agentId, name, repository, and labels), because .runner does
# not store labels. It lets a later run without GitHub access verify labels.
registration_record_path() {
  printf '%s\n' "${RUNNER_ROOT}/.provision-ios-runner"
}

write_registration_record() {
  printf 'agentId=%s\nagentName=%s\ngitHubUrl=%s\nlabels=%s\n' \
    "$(runner_json_value agentId)" "$RUNNER_NAME" "https://github.com/${GITHUB_REPOSITORY}" "$RUNNER_LABELS" \
    >"$(registration_record_path)"
}

# registration_record_value <key>
registration_record_value() {
  local file line
  file="$(registration_record_path)"
  if [[ -f "$file" ]]; then
    while IFS= read -r line; do
      if [[ "$line" == "$1="* ]]; then
        printf '%s\n' "${line#*=}"
        return 0
      fi
    done <"$file"
  fi
  return 0
}

# recorded_labels_match: true when this script's registration record describes
# the current .runner (same agentId, name, and repository) with every label.
recorded_labels_match() {
  local agent_id
  agent_id="$(runner_json_value agentId)"
  [[ -n "$agent_id" && "$(registration_record_value agentId)" == "$agent_id" ]] || return 1
  [[ "$(registration_record_value agentName)" == "$RUNNER_NAME" ]] || return 1
  [[ "$(lowercase "$(registration_record_value gitHubUrl)")" == "$(lowercase "https://github.com/${GITHUB_REPOSITORY}")" ]] || return 1
  [[ -z "$(missing_labels "$(registration_record_value labels)")" ]]
}

# verify_existing_registration: an existing .runner file counts as READY only
# when it belongs to this repository under the expected name and its labels
# are verified, by GitHub when the CLI is authenticated or otherwise by this
# script's own registration record. Anything else stays MISSING and the
# service is left untouched.
verify_existing_registration() {
  local name url expected_url reregister
  name="$(runner_json_value agentName)"
  url="$(runner_json_value gitHubUrl)"
  expected_url="https://github.com/${GITHUB_REPOSITORY}"
  reregister="remove it (cd ${RUNNER_ROOT} && ./config.sh remove) or point RUNNER_NAME/GITHUB_REPOSITORY/RUNNER_ROOT at it, then re-run"
  if [[ "$name" != "$RUNNER_NAME" || "$(lowercase "${url%/}")" != "$(lowercase "$expected_url")" ]]; then
    record "Runner registered" MISSING "${RUNNER_ROOT}/.runner belongs to '${name:-unknown}' at ${url:-an unknown repository}, not ${RUNNER_NAME} at ${expected_url}; ${reregister}"
    return 0
  fi
  if ! gh_authenticated; then
    if recorded_labels_match; then
      REGISTRATION_VERIFIED=1
      record "Runner registered" READY "${RUNNER_NAME} at ${expected_url} (labels ${RUNNER_LABELS} recorded by this script at registration; run gh auth login to confirm with GitHub)"
    else
      record "Runner registered" MISSING "${RUNNER_NAME} at ${expected_url} per ${RUNNER_ROOT}/.runner, but its labels cannot be verified: run gh auth login and re-run, or ${reregister}"
    fi
    return 0
  fi
  local labels missing
  labels="$(github_runner_labels)"
  if [[ -z "$labels" ]]; then
    record "Runner registered" MISSING "${RUNNER_NAME} is not registered in ${GITHUB_REPOSITORY} any more (stale ${RUNNER_ROOT}/.runner); ${reregister}"
    return 0
  fi
  missing="$(missing_labels "$labels")"
  if [[ -n "$missing" ]]; then
    record "Runner registered" MISSING "GitHub lists ${RUNNER_NAME} with labels ${labels}, missing ${missing}; ${reregister}"
    return 0
  fi
  REGISTRATION_VERIFIED=1
  record "Runner registered" READY "${RUNNER_NAME} at ${expected_url} (GitHub labels verified: ${labels})"
}

register_runner() {
  step "Runner registration"
  local url="https://github.com/${GITHUB_REPOSITORY}"
  local redacted="ACTIONS_RUNNER_INPUT_TOKEN=<redacted> ./config.sh --unattended --url ${url} --name ${RUNNER_NAME} --labels ${RUNNER_LABELS} --work ${RUNNER_WORK_DIR} --replace"
  if [[ -f "$RUNNER_ROOT/.runner" ]]; then
    verify_existing_registration
    return 0
  fi
  if ((!CORE_READY && !DRY_RUN)); then
    record "Runner registered" MISSING "registration waits until every core prerequisite above is READY, so GitHub never routes the iOS job to an unprepared Mac"
    return 0
  fi
  if ((DRY_RUN)); then
    plan "obtain a registration token from RUNNER_TOKEN, an authenticated GitHub CLI session (gh api --method POST repos/${GITHUB_REPOSITORY}/actions/runners/registration-token), or a hidden prompt; it is never printed"
    plan "register the runner: ${redacted}"
    record "Runner registered" MISSING "will register ${RUNNER_NAME} with labels ${RUNNER_LABELS}"
    REGISTRATION_PLANNED=1
    return 0
  fi
  if [[ ! -f "$RUNNER_ROOT/config.sh" ]]; then
    record "Runner registered" MISSING "the runner package is not installed"
    return 0
  fi
  if ! obtain_registration_token; then
    record "Runner registered" MISSING "no registration token: export RUNNER_TOKEN, run gh auth login, or re-run interactively"
    return 0
  fi
  log "Registering: ${redacted}"
  local configured=0
  if configure_runner; then
    configured=1
  fi
  REGISTRATION_TOKEN=""
  unset RUNNER_TOKEN
  if ((configured)); then
    write_registration_record || warn "could not write $(registration_record_path); later runs without GitHub access will not be able to verify the labels"
    REGISTRATION_VERIFIED=1
    record "Runner registered" READY "${RUNNER_NAME} at ${url}"
  else
    record "Runner registered" MISSING "config.sh failed; the token may have expired (they last one hour)"
  fi
}

runner_path_value() {
  local parts=("$HOME/.maestro/bin") part result=""
  if [[ -n "$JAVA_BIN_DIR" ]]; then
    parts+=("$JAVA_BIN_DIR")
  fi
  if [[ -n "$NODE_BIN_DIR" ]]; then
    parts+=("$NODE_BIN_DIR")
  fi
  if [[ -n "$BREW_PREFIX" ]]; then
    parts+=("$BREW_PREFIX/bin" "$BREW_PREFIX/sbin")
  fi
  parts+=(/usr/local/bin /usr/bin /bin /usr/sbin /sbin)
  for part in "${parts[@]}"; do
    case ":${result}:" in
      *":${part}:"*) ;;
      *) result="${result:+${result}:}${part}" ;;
    esac
  done
  printf '%s\n' "$result"
}

runner_env_content() {
  printf 'HOME=%s\nLANG=en_US.UTF-8\nPATH=%s\n' "$HOME" "$1"
  if [[ -n "$JAVA_HOME_DIR" ]]; then
    printf 'JAVA_HOME=%s\n' "$JAVA_HOME_DIR"
  fi
}

write_runner_environment() {
  step "Runner service environment"
  local path_value env_content current_path="" current_env=""
  path_value="$(runner_path_value)"
  env_content="$(runner_env_content "$path_value")"
  if [[ -f "$RUNNER_ROOT/.path" ]]; then
    current_path="$(<"$RUNNER_ROOT/.path")"
  fi
  if [[ -f "$RUNNER_ROOT/.env" ]]; then
    current_env="$(<"$RUNNER_ROOT/.env")"
  fi
  if [[ "$current_path" == "$path_value" && "$current_env" == "$env_content" ]]; then
    record "Runner service environment" READY "${RUNNER_ROOT}/.path and .env are current"
    return 0
  fi
  if ((DRY_RUN)); then
    log "[dry-run] write ${RUNNER_ROOT}/.path (the launch agent does not read shell profiles):"
    log "  ${path_value}"
    log "[dry-run] write ${RUNNER_ROOT}/.env:"
    printf '%s\n' "$env_content" | while IFS= read -r line; do log "  ${line}"; done
    record "Runner service environment" MISSING "will write ${RUNNER_ROOT}/.path and .env"
    return 0
  fi
  if [[ ! -f "$RUNNER_ROOT/config.sh" ]]; then
    record "Runner service environment" MISSING "written once the runner package is installed"
    return 0
  fi
  printf '%s\n' "$path_value" >"$RUNNER_ROOT/.path"
  printf '%s\n' "$env_content" >"$RUNNER_ROOT/.env"
  ENVIRONMENT_CHANGED=1
  record "Runner service environment" READY "wrote ${RUNNER_ROOT}/.path and .env"
}

svc() {
  (cd "$RUNNER_ROOT" && ./svc.sh "$@")
}

svc_status() {
  (cd "$RUNNER_ROOT" && ./svc.sh status 2>&1) || true
}

svc_restart() {
  svc stop && svc start
}

install_service() {
  step "Runner launch agent"
  local expected_plist="${HOME}/Library/LaunchAgents/actions.runner.${GITHUB_REPOSITORY//\//-}.${RUNNER_NAME}.plist"
  if [[ ! -x "$RUNNER_ROOT/svc.sh" || ! -f "$RUNNER_ROOT/.runner" ]]; then
    plan "install the runner as a launch agent that starts at every login: ./svc.sh install && ./svc.sh start (creates ${expected_plist})"
    if ((DRY_RUN)); then
      record "Runner launch agent" MISSING "will be installed with ./svc.sh install after registration"
    else
      record "Runner launch agent" MISSING "installed after registration"
    fi
    return 0
  fi
  if ((!IS_MACOS)); then
    record "Runner launch agent" SKIPPED "$SKIP_DETAIL"
    return 0
  fi
  local status
  status="$(svc_status)"
  # svc.sh status prints "not installed", "Stopped", or "Started:" followed by
  # the launchctl entry. A stopped agent reads the new .path and .env when it
  # starts, and svc.sh stop exits when launchctl unload fails (as it can for
  # an agent that is not loaded), so only a started agent is restarted after
  # an environment change.
  if [[ "$status" == *"not installed"* ]]; then
    run_action "install the runner launch agent: ./svc.sh install" svc install || true
    run_action "start the runner launch agent: ./svc.sh start" svc start || true
  elif [[ "$status" == *"Stopped"* ]]; then
    run_action "start the runner launch agent: ./svc.sh start" svc start || true
  elif ((ENVIRONMENT_CHANGED)); then
    run_action "restart the runner so the new .path and .env apply: ./svc.sh stop && ./svc.sh start" svc_restart || true
  fi
  status="$(svc_status)"
  local plist="" line
  while IFS= read -r line; do
    if [[ "$line" == *.plist ]]; then
      plist="$line"
    fi
  done <<<"$status"
  if [[ "$status" == *"Started:"* ]]; then
    record "Runner launch agent" READY "${plist:-$expected_plist} (started)"
  elif ((DRY_RUN)); then
    record "Runner launch agent" MISSING "will be installed and started with ./svc.sh"
  else
    record "Runner launch agent" MISSING "not running; run ./svc.sh status in ${RUNNER_ROOT} from the logged-in desktop session"
  fi
}

# withhold_service <condition>: the service steps are not run (an existing
# launch agent is left untouched) and the report says what must happen first.
withhold_service() {
  step "Runner service environment"
  record "Runner service environment" MISSING "written once ${1}"
  step "Runner launch agent"
  record "Runner launch agent" MISSING "not installed or started until ${1}; any existing launch agent is left untouched"
}

# finish_runner_service: the runner service is installed or started only for a
# verified registration on a Mac whose core prerequisites are all READY (a dry
# run that would register plans the steps instead).
finish_runner_service() {
  if ((REGISTRATION_PLANNED)) || ((REGISTRATION_VERIFIED && CORE_READY)); then
    write_runner_environment
    install_service
  elif ((!REGISTRATION_VERIFIED)); then
    withhold_service "the runner registration above is verified"
  else
    withhold_service "every core prerequisite above is READY"
  fi
}

# ---------------------------------------------------------------------------
# Readiness report and GitHub confirmation
# ---------------------------------------------------------------------------

OVERALL="READY"

print_report() {
  local index
  printf '\n## iOS release runner readiness\n\n'
  log "- Repository: https://github.com/${GITHUB_REPOSITORY}"
  log "- Host: ${HOST_DESCRIPTION}"
  if ((DRY_RUN)); then
    log "- Mode: dry run (no changes were made)"
  fi

  printf '\n### Prerequisites\n\n'
  log "| Prerequisite | Status | Detail |"
  log "| --- | --- | --- |"
  for ((index = 0; index < ${#ROW_NAMES[@]}; index++)); do
    log "| ${ROW_NAMES[index]} | ${ROW_STATUSES[index]} | ${ROW_DETAILS[index]} |"
    if [[ "${ROW_STATUSES[index]}" != "READY" ]]; then
      OVERALL="INCOMPLETE"
    fi
  done

  printf '\n### Runner labels\n\n'
  log "- Name: ${RUNNER_NAME}"
  log "- Labels: ${RUNNER_LABELS//,/, }"
  log "- Runner release: ${RUNNER_VERSION} (verified by SHA-256 before extraction; self-updates afterwards)"

  printf '\n### GitHub configuration still needed\n\n'
  log "Create these in the repository settings; the script reads names only and never values."
  log "Environment \`${GITHUB_ENVIRONMENT}\` secrets:"
  local name
  for name in $IOS_JOB_ENVIRONMENT_SECRETS; do
    log "- ${name}"
  done
  log "Optional environment \`${GITHUB_ENVIRONMENT}\` secret:"
  for name in $IOS_JOB_OPTIONAL_SECRETS; do
    log "- ${name}"
  done
  log "Repository-level variable (the workflow reads it through vars., outside the environment):"
  for name in $IOS_JOB_REPOSITORY_VARIABLES; do
    log "- ${name}"
  done
  log "Public repository reminder: Settings > Actions > General > Approval for running fork pull request workflows must require approval for all outside collaborators before this self-hosted runner is relied on."
}

github_names_status() {
  # github_names_status <known names> <required names>
  local known="$1" name
  for name in $2; do
    case " ${known} " in
      *" ${name} "*) log "- ${name}: present" ;;
      *) log "- ${name}: MISSING" ;;
    esac
  done
}

github_check() {
  printf '\n### GitHub status\n\n'
  local runner_status
  runner_status="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runners" --paginate \
    --jq ".runners[] | select(.name == \"${RUNNER_NAME}\") | \"status=\(.status) busy=\(.busy) labels=\([.labels[].name] | join(\",\"))\"" 2>/dev/null || true)"
  if [[ -n "$runner_status" ]]; then
    log "- Runner ${RUNNER_NAME}: ${runner_status}"
  else
    log "- Runner ${RUNNER_NAME}: not registered yet, or the GitHub CLI cannot read repository runners"
  fi

  if gh api "repos/${GITHUB_REPOSITORY}/environments/${GITHUB_ENVIRONMENT}" >/dev/null 2>&1; then
    local secret_names
    secret_names="$(gh api "repos/${GITHUB_REPOSITORY}/environments/${GITHUB_ENVIRONMENT}/secrets" --paginate --jq '.secrets[].name' 2>/dev/null | tr '\n' ' ' || true)"
    log "- Environment ${GITHUB_ENVIRONMENT}: present"
    github_names_status "$secret_names" "$IOS_JOB_ENVIRONMENT_SECRETS $IOS_JOB_OPTIONAL_SECRETS"
  else
    log "- Environment ${GITHUB_ENVIRONMENT}: MISSING (create it under Settings > Environments, then add the secrets listed above)"
  fi

  # Only the names are read here; variable values are never printed.
  local variable_names
  variable_names="$(gh api "repos/${GITHUB_REPOSITORY}/actions/variables" --paginate --jq '.variables[].name' 2>/dev/null | tr '\n' ' ' || true)"
  github_names_status "$variable_names" "$IOS_JOB_REPOSITORY_VARIABLES"
}

offer_github_check() {
  if ((NO_GITHUB)); then
    return 0
  fi
  local manual="gh api repos/${GITHUB_REPOSITORY}/actions/runners --jq '.runners[] | select(.name == \"${RUNNER_NAME}\") | {name, status, busy, labels: [.labels[].name]}'"
  if ! gh_authenticated; then
    printf '\n'
    log "Confirm the runner later with an authenticated GitHub CLI: ${manual}"
    return 0
  fi
  if ((CHECK_GITHUB)); then
    github_check
    return 0
  fi
  if ((DRY_RUN)) || ! is_interactive; then
    printf '\n'
    log "Re-run with --check-github to confirm on GitHub that ${RUNNER_NAME} is online and which names already exist, or run: ${manual}"
    return 0
  fi
  local answer=""
  read -r -p "Check GitHub now for the runner status and the configured names? [y/N] " answer || answer=""
  case "$answer" in
    y|Y|yes|YES) github_check ;;
    *) log "Skipped. Later: ${manual}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# When sourced (the shell tests do this with --dry-run), stop here so the
# functions above can be exercised individually without running the procedure.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

log "iOS release runner setup for https://github.com/${GITHUB_REPOSITORY} on ${HOST_DESCRIPTION}"
if ((DRY_RUN)); then
  log "Dry run: every action is printed and nothing is changed."
fi

check_xcode
check_homebrew
check_node
check_pnpm
check_java
check_maestro
check_playwright
check_shared_release_commands
check_simulator
check_candidate
if ((SKIP_REGISTRATION)); then
  step "Runner"
  record "GitHub Actions runner ${RUNNER_VERSION}" SKIPPED "--skip-registration"
  record "Runner registered" SKIPPED "--skip-registration"
  record "Runner launch agent" SKIPPED "--skip-registration"
else
  check_runner_package
  register_runner
  finish_runner_service
fi

print_report
offer_github_check

printf '\n'
log "RUNNER_VERSION=${RUNNER_VERSION}"
log "PNPM_VERSION=${IOS_RUNNER_PNPM_VERSION}"
log "RUNNER_NAME=${RUNNER_NAME}"
log "RUNNER_LABELS=${RUNNER_LABELS}"
log "IOS_RELEASE_RUNNER=${OVERALL}"

if ((DRY_RUN)); then
  exit 0
fi
if [[ "$OVERALL" == "READY" ]]; then
  exit 0
fi
exit 1
