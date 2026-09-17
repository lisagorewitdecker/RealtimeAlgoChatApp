#!/usr/bin/env bash
#
# Exercises scripts/provision-ios-runner.sh in dry-run mode on Linux so the
# runner label set, the pinned runner release, the toolchain versions, and the
# readiness report stay in step with .github/workflows/mobile-release.yml and
# the device-check documentation. macOS-only actions are skipped by the script
# itself; this test never touches the real HOME.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROVISION="$WORKSPACE_ROOT/scripts/provision-ios-runner.sh"
WORKFLOW="$WORKSPACE_ROOT/.github/workflows/mobile-release.yml"
DOCS="$WORKSPACE_ROOT/artifacts/chat-app/docs/native-large-text-device-check.md"
API_SERVER_MANIFEST="$WORKSPACE_ROOT/artifacts/api-server/package.json"
BASH_BIN="$(command -v bash)"
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
    echo "iOS runner provisioning test cleanup escaped its fixture directory" >&2
    return 1
  fi
  rm -rf "$test_parent"
}

trap cleanup_test_fixtures EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Expected values, read from the workflow, the docs, and the API package so
# the script cannot drift from them silently.
# ---------------------------------------------------------------------------

native_ios_job="$(sed -n '/^  native-ios:$/,/^  [a-z][a-z-]*:$/p' "$WORKFLOW")"
[[ -n "$native_ios_job" ]] || fail "could not find the native-ios job in $WORKFLOW"

expected_labels="$(
  printf '%s\n' "$native_ios_job" |
    sed -n '/^    runs-on:$/,/^    timeout-minutes:/p' |
    sed -n 's/^      - \([a-z][a-z-]*\)$/\1/p' |
    tr '\n' ','
)"
expected_labels="${expected_labels%,}"
[[ "$expected_labels" == *,*,* ]] || fail "could not read the native-ios runs-on labels (got '$expected_labels')"

expected_environment="$(printf '%s\n' "$native_ios_job" | sed -n 's/^      name: \([a-z][a-z-]*\)$/\1/p' | head -n 1)"
[[ -n "$expected_environment" ]] || fail "could not read the native-ios environment name"

expected_secrets="$(printf '%s\n' "$native_ios_job" | "$GREP_BIN" -o 'secrets\.[A-Z_][A-Z0-9_]*' | sed 's/^secrets\.//' | sort -u)"
[[ -n "$expected_secrets" ]] || fail "could not read the secrets the native-ios job uses"

# Repository variables reach the job through the workflow-level env block
# (NAME: ${{ ... vars.NAME }}), so collect every vars.* name the workflow
# declares and keep the ones the native-ios job actually reads as env.NAME.
expected_variables=""
while IFS= read -r variable; do
  if [[ -n "$variable" ]] && "$GREP_BIN" -Fq -- "env.${variable}" <<<"$native_ios_job"; then
    expected_variables="${expected_variables:+$expected_variables$'\n'}${variable}"
  fi
done <<<"$(sed -n 's/.*vars\.\([A-Z_][A-Z0-9_]*\).*/\1/p' "$WORKFLOW" | sort -u)"
[[ -n "$expected_variables" ]] || fail "could not read the repository variables the native-ios job uses"

expected_pnpm="$(sed -n 's/^  PNPM_VERSION: \([0-9][0-9.]*\)$/\1/p' "$WORKFLOW" | head -n 1)"
[[ -n "$expected_pnpm" ]] || fail "could not read PNPM_VERSION from $WORKFLOW"

expected_runner_version="$(sed -n 's/^RUNNER_VERSION=\([0-9][0-9.]*\)$/\1/p' "$DOCS" | sort -u)"
[[ "$expected_runner_version" == [0-9]*.[0-9]*.[0-9]* && "$expected_runner_version" != *$'\n'* ]] ||
  fail "expected exactly one RUNNER_VERSION= pin in $DOCS (got '$expected_runner_version')"

expected_playwright="$(sed -n 's/^[[:space:]]*"@playwright\/test": "\([^"]*\)".*/\1/p' "$API_SERVER_MANIFEST" | head -n 1)"
[[ -n "$expected_playwright" ]] || fail "could not read the @playwright/test version from $API_SERVER_MANIFEST"

case "$(uname -m)" in
  x86_64) expected_arch="x64" ;;
  aarch64 | arm64) expected_arch="arm64" ;;
  *) fail "unsupported test host architecture: $(uname -m)" ;;
esac

# ---------------------------------------------------------------------------
# Isolated PATH: only the utilities the script needs, plus optional stubs.
# ---------------------------------------------------------------------------

make_utilities() {
  local directory="$1" command
  mkdir -p "$directory"
  for command in uname sed head tail tr date cat mkdir mktemp rm id sort grep find sha256sum; do
    ln -s "$(command -v "$command")" "$directory/$command"
  done
}

# make_download_stubs <directory>: curl writes a fixed payload to --output and
# tar only records its arguments in TAR_LOG, so the download path can be
# exercised without network access or a real archive.
make_download_stubs() {
  local directory="$1"
  mkdir -p "$directory"
  cat >"$directory/curl" <<EOF
#!${BASH_BIN}
output=""
while ((\$#)); do
  if [[ "\$1" == "--output" ]]; then output="\$2"; shift; fi
  shift
done
[[ -n "\$output" ]] || exit 1
printf '%s\\n' "${download_payload}" >"\$output"
EOF
  cat >"$directory/tar" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$TAR_LOG"
EOF
  chmod +x "$directory/curl" "$directory/tar"
}

# make_gh_stub <directory>: reports an authenticated CLI and answers the
# runner query with GH_STUB_RUNNER_LABELS.
make_gh_stub() {
  local directory="$1"
  mkdir -p "$directory"
  cat >"$directory/gh" <<EOF
#!${BASH_BIN}
case "\$*" in
  "auth status") exit 0 ;;
  *actions/runners*) printf '%s\\n' "\${GH_STUB_RUNNER_LABELS:-}" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$directory/gh"
}

# make_registered_runner_root <directory> <agent name> <github url>
make_registered_runner_root() {
  mkdir -p "$1"
  : >"$1/config.sh"
  printf '{\n  "agentId": 7,\n  "agentName": "%s",\n  "poolId": 1,\n  "gitHubUrl": "%s",\n  "workFolder": "_work"\n}\n' "$2" "$3" >"$1/.runner"
}

make_toolchain_stubs() {
  local directory="$1" java_version="$2"
  mkdir -p "$directory"
  printf '#!%s\nprintf "v24.13.0\\n"\n' "$BASH_BIN" >"$directory/node"
  printf '#!%s\nprintf "%s\\n"\n' "$BASH_BIN" "$expected_pnpm" >"$directory/pnpm"
  printf '#!%s\nprintf "1.41.0\\n"\n' "$BASH_BIN" >"$directory/maestro"
  printf '#!%s\necho '"'"'openjdk version "%s"'"'"' >&2\n' "$BASH_BIN" "$java_version" >"$directory/java"
  chmod +x "$directory/node" "$directory/pnpm" "$directory/maestro" "$directory/java"
}

assert_contains() {
  local output="$1" expected="$2"
  "$GREP_BIN" -Fq -- "$expected" <<<"$output" || {
    printf 'Expected output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

assert_matches() {
  local output="$1" pattern="$2"
  "$GREP_BIN" -Eq -- "$pattern" <<<"$output" || {
    printf 'Expected output to match: %s\n%s\n' "$pattern" "$output" >&2
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

# run_case <name> <expected exit> <PATH> <HOME> [ENV=value ...] -- [script args ...]
run_case() {
  local name="$1" expected_status="$2" path="$3" home="$4"
  shift 4
  local assignments=()
  while (($#)) && [[ "$1" != "--" ]]; do
    assignments+=("$1")
    shift
  done
  if (($#)); then
    shift
  fi
  mkdir -p "$home"
  local output status
  if output="$("$ENV_BIN" -i \
    PATH="$path" \
    HOME="$home" \
    ${assignments[@]+"${assignments[@]}"} \
    "$BASH_BIN" "$PROVISION" "$@" 2>&1
  )"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

download_payload="runner-archive-payload"
utilities="$test_root/utilities"
make_utilities "$utilities"
token_sentinel="registration-token-must-never-print"
repository_url="https://github.com/lisagorewitdecker/RealtimeAlgoChatApp"

# ---------------------------------------------------------------------------
# Bare dry run: nothing installed, every action printed, nothing changed.
# ---------------------------------------------------------------------------

bare_home="$test_root/home-bare"
bare_output="$(
  run_case bare-dry-run 0 "$utilities" "$bare_home" \
    RUNNER_TOKEN="$token_sentinel" \
    -- --dry-run
)"

assert_contains "$bare_output" "Dry run: every action is printed and nothing is changed."
assert_contains "$bare_output" "## iOS release runner readiness"
assert_contains "$bare_output" "### Prerequisites"
assert_contains "$bare_output" "| Prerequisite | Status | Detail |"
assert_contains "$bare_output" "### Runner labels"
assert_contains "$bare_output" "### GitHub configuration still needed"
assert_contains "$bare_output" "Environment \`${expected_environment}\` secrets:"

assert_contains "$bare_output" "RUNNER_LABELS=${expected_labels}"
assert_contains "$bare_output" "--labels ${expected_labels} "
assert_contains "$bare_output" "RUNNER_VERSION=${expected_runner_version}"
assert_contains "$bare_output" "PNPM_VERSION=${expected_pnpm}"
assert_contains "$bare_output" "RUNNER_NAME=ios-release-mac"
assert_contains "$bare_output" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_contains "$bare_output" "actions-runner-osx-${expected_arch}-${expected_runner_version}.tar.gz"
assert_matches "$bare_output" "verify SHA-256 [0-9a-f]{64},"

assert_contains "$bare_output" "ACTIONS_RUNNER_INPUT_TOKEN=<redacted> ./config.sh --unattended"
assert_not_contains "$bare_output" "--token"
assert_contains "$bare_output" "--name ios-release-mac"
assert_contains "$bare_output" "--replace"
assert_contains "$bare_output" "./svc.sh install && ./svc.sh start"
assert_contains "$bare_output" "/.maestro/bin"
assert_contains "$bare_output" "brew install node@24"
assert_contains "$bare_output" "corepack prepare pnpm@${expected_pnpm} --activate"
assert_contains "$bare_output" "brew install openjdk@17"
assert_contains "$bare_output" "https://get.maestro.mobile.dev"
assert_contains "$bare_output" "pnpm dlx playwright@${expected_playwright} install chromium"
assert_contains "$bare_output" "xcrun simctl bootstatus"
assert_contains "$bare_output" "| Xcode with simctl | SKIPPED |"
assert_contains "$bare_output" "| Booted iPhone SE (3rd generation) | SKIPPED |"
assert_contains "$bare_output" "| Node.js 24 | MISSING |"
assert_contains "$bare_output" "| pnpm ${expected_pnpm} | MISSING |"
assert_contains "$bare_output" "| Java 17 or newer | MISSING |"
assert_contains "$bare_output" "| Maestro | MISSING |"
assert_contains "$bare_output" "| GitHub Actions runner ${expected_runner_version} | MISSING |"
assert_contains "$bare_output" "| Runner registered | MISSING |"
assert_contains "$bare_output" "| Runner launch agent | MISSING |"
assert_contains "$bare_output" "require approval for all outside collaborators"

while IFS= read -r secret; do
  assert_contains "$bare_output" "- ${secret}"
done <<<"$expected_secrets"
while IFS= read -r variable; do
  assert_contains "$bare_output" "- ${variable}"
done <<<"$expected_variables"

assert_not_contains "$bare_output" "$token_sentinel"
if [[ -n "$(find "$bare_home" -mindepth 1 -print -quit)" ]]; then
  fail "dry run must not create anything under HOME: $(find "$bare_home" -mindepth 1)"
fi

# ---------------------------------------------------------------------------
# Toolchain present: the report turns those rows READY and skips installers.
# ---------------------------------------------------------------------------

stubs="$test_root/stubs"
make_toolchain_stubs "$stubs" "17.0.13"
toolchain_home="$test_root/home-toolchain"
mkdir -p "$toolchain_home/.cache/ms-playwright/chromium-1234"

toolchain_output="$(
  run_case toolchain-dry-run 0 "$stubs:$utilities" "$toolchain_home" \
    RUNNER_TOKEN="$token_sentinel" \
    -- --dry-run
)"

assert_contains "$toolchain_output" "| Node.js 24 | READY | v24.13.0"
assert_contains "$toolchain_output" "| pnpm ${expected_pnpm} | READY |"
assert_contains "$toolchain_output" "| Java 17 or newer | READY | Java 17"
assert_contains "$toolchain_output" "| Maestro | READY | 1.41.0"
assert_contains "$toolchain_output" "| Playwright Chromium | READY |"
assert_not_contains "$toolchain_output" "brew install node@24"
assert_not_contains "$toolchain_output" "corepack prepare"
assert_not_contains "$toolchain_output" "brew install openjdk@17"
assert_not_contains "$toolchain_output" "install Maestro"
assert_not_contains "$toolchain_output" "pnpm dlx playwright"
assert_contains "$toolchain_output" "IOS_RELEASE_RUNNER=INCOMPLETE"
assert_not_contains "$toolchain_output" "$token_sentinel"

# ---------------------------------------------------------------------------
# Java below the minimum stays MISSING even when a java binary exists.
# ---------------------------------------------------------------------------

old_java="$test_root/old-java"
make_toolchain_stubs "$old_java" "11.0.2"
old_java_output="$(
  run_case old-java-dry-run 0 "$old_java:$utilities" "$test_root/home-old-java" \
    -- --dry-run
)"
assert_contains "$old_java_output" "| Java 17 or newer | MISSING | found 11;"

# ---------------------------------------------------------------------------
# run_sourced <name> <expected status> <PATH> <HOME> [VAR=value ...] -- <snippet>
# Sources the script (it returns before its main section when sourced) and
# runs <snippet> against its functions, so non-dry-run paths can be exercised
# on Linux with stubbed tools.
# ---------------------------------------------------------------------------

run_sourced() {
  local name="$1" expected_status="$2" path="$3" home="$4"
  shift 4
  local assignments=()
  while (($#)) && [[ "$1" != "--" ]]; do
    assignments+=("$1")
    shift
  done
  if (($#)); then
    shift
  fi
  mkdir -p "$home"
  local driver="$test_root/driver-${name}.sh"
  {
    printf 'set -- --dry-run\n'
    printf 'source %q\n' "$PROVISION"
    printf '%s\n' "$1"
  } >"$driver"
  local output status
  if output="$("$ENV_BIN" -i \
    PATH="$path" \
    HOME="$home" \
    ${assignments[@]+"${assignments[@]}"} \
    "$BASH_BIN" "$driver" 2>&1
  )"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne "$expected_status" ]]; then
    printf '%s: expected exit %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$name" >&2
  printf '%s\n' "$output"
}

# make_svc_stub <runner root>: svc.sh records every call in SVC_LOG and keeps
# a small state so status answers like the real script (not installed,
# Stopped, Started: plus the plist path).
make_svc_stub() {
  cat >"$1/svc.sh" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$SVC_LOG"
state="\${0%/*}/.svc-state"
case "\$1" in
  install) printf 'installed\\n' >"\$state" ;;
  start) printf 'started\\n' >"\$state" ;;
  stop) printf 'installed\\n' >"\$state" ;;
  status)
    if [[ ! -f "\$state" ]]; then
      printf 'not installed\\n'
    elif [[ "\$(<"\$state")" == started ]]; then
      printf 'Started:\\n4242 0 actions.runner.test\\n\\n%s/Library/LaunchAgents/actions.runner.test.plist\\n' "\$HOME"
    else
      printf 'Stopped\\n'
    fi
    ;;
esac
EOF
  chmod +x "$1/svc.sh"
}

# make_registration_record <runner root> <agent id> <labels>
make_registration_record() {
  printf 'agentId=%s\nagentName=ios-release-mac\ngitHubUrl=%s\nlabels=%s\n' "$2" "$repository_url" "$3" >"$1/.provision-ios-runner"
}

withheld_for_registration="| Runner launch agent | MISSING | not installed or started until the runner registration above is verified; any existing launch agent is left untouched |"
withheld_for_core="| Runner launch agent | MISSING | not installed or started until every core prerequisite above is READY; any existing launch agent is left untouched |"

# ---------------------------------------------------------------------------
# Existing registrations are READY only when they match this repository and
# runner name and their labels are verified (GitHub, or this script's own
# registration record); the service is withheld for anything else.
# ---------------------------------------------------------------------------

mismatch_root="$test_root/runner-mismatch"
make_registered_runner_root "$mismatch_root" "other-mac" "$repository_url"
mismatch_output="$(
  run_case registration-name-mismatch 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$mismatch_root" \
    -- --dry-run
)"
assert_contains "$mismatch_output" "| Runner registered | MISSING | ${mismatch_root}/.runner belongs to 'other-mac'"
assert_contains "$mismatch_output" "./config.sh remove"
assert_contains "$mismatch_output" "$withheld_for_registration"

foreign_root="$test_root/runner-foreign"
make_registered_runner_root "$foreign_root" "ios-release-mac" "https://github.com/example/other-repository"
foreign_output="$(
  run_case registration-repository-mismatch 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$foreign_root" \
    -- --dry-run
)"
assert_contains "$foreign_output" "| Runner registered | MISSING |"
assert_contains "$foreign_output" "https://github.com/example/other-repository, not ios-release-mac at ${repository_url}"
assert_contains "$foreign_output" "$withheld_for_registration"

matching_root="$test_root/runner-matching"
make_registered_runner_root "$matching_root" "ios-release-mac" "${repository_url}/"
unverified_output="$(
  run_case registration-labels-unverifiable 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" \
    -- --dry-run
)"
assert_contains "$unverified_output" "| Runner registered | MISSING | ios-release-mac at ${repository_url} per ${matching_root}/.runner, but its labels cannot be verified: run gh auth login"
assert_contains "$unverified_output" "$withheld_for_registration"

make_registration_record "$matching_root" 3 "$expected_labels"
stale_record_output="$(
  run_case registration-record-stale 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" \
    -- --dry-run
)"
assert_contains "$stale_record_output" "| Runner registered | MISSING | ios-release-mac at ${repository_url} per ${matching_root}/.runner, but its labels cannot be verified"

make_registration_record "$matching_root" 7 "ios,smallest-simulator"
short_record_output="$(
  run_case registration-record-missing-labels 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" \
    -- --dry-run
)"
assert_contains "$short_record_output" "| Runner registered | MISSING | ios-release-mac at ${repository_url} per ${matching_root}/.runner, but its labels cannot be verified"

make_registration_record "$matching_root" 7 "$expected_labels"
recorded_output="$(
  run_case registration-record-verified 0 "$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" \
    -- --dry-run
)"
assert_contains "$recorded_output" "| Runner registered | READY | ios-release-mac at ${repository_url} (labels ${expected_labels} recorded by this script at registration"
assert_contains "$recorded_output" "$withheld_for_core"

gh_stub="$test_root/gh-stub"
make_gh_stub "$gh_stub"
labels_missing_output="$(
  run_case registration-labels-missing-on-github 0 "$gh_stub:$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" GH_STUB_RUNNER_LABELS="self-hosted,macOS,X64,ios" \
    -- --dry-run
)"
assert_contains "$labels_missing_output" "| Runner registered | MISSING | GitHub lists ios-release-mac with labels self-hosted,macOS,X64,ios, missing smallest-simulator;"
assert_contains "$labels_missing_output" "$withheld_for_registration"

labels_verified_output="$(
  run_case registration-labels-verified-on-github 0 "$gh_stub:$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" GH_STUB_RUNNER_LABELS="self-hosted,macOS,X64,ios,smallest-simulator" \
    -- --dry-run
)"
assert_contains "$labels_verified_output" "| Runner registered | READY | ios-release-mac at ${repository_url} (GitHub labels verified: self-hosted,macOS,X64,ios,smallest-simulator)"
assert_contains "$labels_verified_output" "$withheld_for_core"

removed_output="$(
  run_case registration-removed-on-github 0 "$gh_stub:$utilities" "$test_root/home-registration" \
    RUNNER_ROOT="$matching_root" GH_STUB_RUNNER_LABELS="" \
    -- --dry-run
)"
assert_contains "$removed_output" "| Runner registered | MISSING | ios-release-mac is not registered in lisagorewitdecker/RealtimeAlgoChatApp any more"
assert_contains "$removed_output" "$withheld_for_registration"

# ---------------------------------------------------------------------------
# Outside dry run, an invalid registration must never install or start the
# service, and a verified one must (with .path and .env written first).
# ---------------------------------------------------------------------------

service_snippet='DRY_RUN=0; IS_MACOS=1; CORE_READY=1; register_runner; finish_runner_service'

foreign_service_root="$test_root/runner-foreign-service"
make_registered_runner_root "$foreign_service_root" "ios-release-mac" "https://github.com/example/other-repository"
make_svc_stub "$foreign_service_root"
foreign_service_output="$(
  run_sourced service-withheld-for-foreign-registration 0 "$utilities" "$test_root/home-service" \
    RUNNER_ROOT="$foreign_service_root" SVC_LOG="$test_root/svc-foreign.log" \
    -- "$service_snippet"
)"
assert_contains "$foreign_service_output" "[MISSING] Runner registered: ${foreign_service_root}/.runner belongs to 'ios-release-mac' at https://github.com/example/other-repository"
assert_contains "$foreign_service_output" "[MISSING] Runner launch agent: not installed or started until the runner registration above is verified"
if [[ -e "$test_root/svc-foreign.log" ]]; then
  fail "svc.sh must never run for a registration that belongs to another repository: $(cat "$test_root/svc-foreign.log")"
fi
[[ ! -e "$foreign_service_root/.path" && ! -e "$foreign_service_root/.env" ]] || fail ".path/.env must not be written for an unverified registration"

unverified_service_root="$test_root/runner-unverified-service"
make_registered_runner_root "$unverified_service_root" "ios-release-mac" "$repository_url"
make_svc_stub "$unverified_service_root"
run_sourced service-withheld-without-label-verification 0 "$utilities" "$test_root/home-service" \
  RUNNER_ROOT="$unverified_service_root" SVC_LOG="$test_root/svc-unverified.log" \
  -- "$service_snippet" >/dev/null
if [[ -e "$test_root/svc-unverified.log" ]]; then
  fail "svc.sh must never run while the labels are unverified: $(cat "$test_root/svc-unverified.log")"
fi

core_missing_root="$test_root/runner-core-missing-service"
make_registered_runner_root "$core_missing_root" "ios-release-mac" "$repository_url"
make_registration_record "$core_missing_root" 7 "$expected_labels"
make_svc_stub "$core_missing_root"
core_missing_output="$(
  run_sourced service-withheld-until-core-ready 0 "$utilities" "$test_root/home-service" \
    RUNNER_ROOT="$core_missing_root" SVC_LOG="$test_root/svc-core-missing.log" \
    -- 'DRY_RUN=0; IS_MACOS=1; CORE_READY=0; register_runner; finish_runner_service'
)"
assert_contains "$core_missing_output" "[READY] Runner registered:"
assert_contains "$core_missing_output" "[MISSING] Runner launch agent: not installed or started until every core prerequisite above is READY"
if [[ -e "$test_root/svc-core-missing.log" ]]; then
  fail "svc.sh must never run while a core prerequisite is missing: $(cat "$test_root/svc-core-missing.log")"
fi

verified_service_root="$test_root/runner-verified-service"
make_registered_runner_root "$verified_service_root" "ios-release-mac" "$repository_url"
make_registration_record "$verified_service_root" 7 "$expected_labels"
make_svc_stub "$verified_service_root"
verified_service_output="$(
  run_sourced service-installed-for-verified-registration 0 "$utilities" "$test_root/home-service" \
    RUNNER_ROOT="$verified_service_root" SVC_LOG="$test_root/svc-verified.log" \
    -- "$service_snippet"
)"
assert_contains "$verified_service_output" "[READY] Runner registered: ios-release-mac at ${repository_url} (labels ${expected_labels} recorded by this script at registration"
assert_contains "$verified_service_output" "[READY] Runner service environment: wrote ${verified_service_root}/.path and .env"
assert_contains "$verified_service_output" "[READY] Runner launch agent: ${test_root}/home-service/Library/LaunchAgents/actions.runner.test.plist (started)"
[[ -f "$test_root/svc-verified.log" ]] || fail "svc.sh should install and start a verified registration"
assert_contains "$(cat "$test_root/svc-verified.log")" "install"
assert_contains "$(cat "$test_root/svc-verified.log")" "start"
assert_contains "$(cat "$verified_service_root/.path")" "$test_root/home-service/.maestro/bin"
assert_contains "$(cat "$verified_service_root/.env")" "HOME=$test_root/home-service"

# ---------------------------------------------------------------------------
# The simulator login agent must boot the device itself, then wait for it;
# boot_simulator does the same and tolerates an already-booted device.
# ---------------------------------------------------------------------------

simulator_udid="ABCDEF12-3456-7890-ABCD-EF1234567890"
xcrun_stub="$test_root/xcrun-stub"
mkdir -p "$xcrun_stub"
cat >"$xcrun_stub/xcrun" <<EOF
#!${BASH_BIN}
printf '%s\\n' "\$*" >>"\$XCRUN_LOG"
if [[ "\$2" == boot ]]; then
  printf 'Unable to boot device in current state: Booted\\n' >&2
  exit 149
fi
EOF
chmod +x "$xcrun_stub/xcrun"
simulator_output="$(
  run_sourced simulator-agent-boots-then-waits 0 "$xcrun_stub:$utilities" "$test_root/home-simulator" \
    XCRUN_LOG="$test_root/xcrun.log" \
    -- "simulator_agent_plist $simulator_udid; boot_simulator $simulator_udid"
)"
assert_contains "$simulator_output" "<string>/bin/sh</string>"
assert_contains "$simulator_output" "<string>/usr/bin/xcrun simctl boot ${simulator_udid}; exec /usr/bin/xcrun simctl bootstatus ${simulator_udid} -b</string>"
assert_contains "$simulator_output" "<key>RunAtLoad</key>"
[[ "$(cat "$test_root/xcrun.log")" == "simctl boot ${simulator_udid}
simctl bootstatus ${simulator_udid} -b" ]] || fail "boot_simulator must run simctl boot and then bootstatus -b even when the device is already booted; got: $(cat "$test_root/xcrun.log")"

# ---------------------------------------------------------------------------
# Runner archive: a digest mismatch must stop before extraction. curl and tar
# are stubbed; the digest check runs for real through sha256sum.
# ---------------------------------------------------------------------------

download_stubs="$test_root/download-stubs"
make_download_stubs "$download_stubs"
payload_sha256="$(printf '%s\n' "$download_payload" | sha256sum | sed 's/ .*//')"
install_snippet='RUNNER_SHA256="$EXPECTED_SHA256"; install_runner_package "https://example.invalid/actions-runner-osx-x64-test.tar.gz"'

mismatch_tar_log="$test_root/tar-mismatch.log"
mismatch_install_output="$(
  run_sourced archive-digest-mismatch 1 "$download_stubs:$utilities" "$test_root/home-install" \
    RUNNER_ROOT="$test_root/runner-install" TAR_LOG="$mismatch_tar_log" \
    EXPECTED_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
    -- "$install_snippet"
)"
assert_contains "$mismatch_install_output" "SHA-256 mismatch"
if [[ -e "$mismatch_tar_log" ]]; then
  fail "tar must never run when the runner archive digest does not match: $(cat "$mismatch_tar_log")"
fi

match_tar_log="$test_root/tar-match.log"
run_sourced archive-digest-match 0 "$download_stubs:$utilities" "$test_root/home-install" \
  RUNNER_ROOT="$test_root/runner-install" TAR_LOG="$match_tar_log" EXPECTED_SHA256="$payload_sha256" \
  -- "$install_snippet" >/dev/null
[[ -f "$match_tar_log" ]] || fail "tar should extract the archive once its digest matches"
assert_contains "$(cat "$match_tar_log")" "-xzf"
assert_contains "$(cat "$match_tar_log")" "-C $test_root/runner-install"

# ---------------------------------------------------------------------------
# Usage errors: token on the command line, no dry run on Linux, missing
# candidate path, conflicting GitHub flags. Help exits cleanly.
# ---------------------------------------------------------------------------

token_output="$(
  run_case token-argument-rejected 2 "$utilities" "$test_root/home-usage" \
    -- --dry-run --token "$token_sentinel"
)"
assert_contains "$token_output" "never accepted on the command line"
assert_not_contains "$token_output" "$token_sentinel"

linux_output="$(
  run_case linux-requires-dry-run 2 "$utilities" "$test_root/home-usage" --
)"
assert_contains "$linux_output" "supports macOS only"

candidate_output="$(
  run_case candidate-path-required 2 "$utilities" "$test_root/home-usage" \
    -- --dry-run --install-candidate
)"
assert_contains "$candidate_output" "NATIVE_SMOKE_IOS_APP_PATH"

conflict_output="$(
  run_case github-flags-conflict 2 "$utilities" "$test_root/home-usage" \
    -- --dry-run --check-github --no-github
)"
assert_contains "$conflict_output" "cannot be combined"

help_output="$(
  run_case help 0 "$utilities" "$test_root/home-usage" -- --help
)"
assert_contains "$help_output" "Usage: provision-ios-runner.sh"
assert_contains "$help_output" "RUNNER_TOKEN"

# ---------------------------------------------------------------------------
# Docs must describe the same script, labels, pin, and GitHub configuration.
# ---------------------------------------------------------------------------

# Prose wraps across lines, so compare against a single-line rendering.
docs="$(tr '\n' ' ' <"$DOCS" | tr -s ' ')"
assert_docs_contains() {
  "$GREP_BIN" -Fq -- "$1" <<<"$docs" || fail "Expected $DOCS to mention: $1"
}
assert_docs_contains "scripts/provision-ios-runner.sh --dry-run"
assert_docs_contains "$expected_labels"
assert_docs_contains "ios-release-mac"
assert_docs_contains "RUNNER_TOKEN"
assert_docs_contains "IOS_RELEASE_RUNNER=READY"
assert_docs_contains "require approval for all outside collaborators"
assert_docs_contains "repository sync task"
assert_docs_contains "svc.sh"
assert_docs_contains "test:ios-runner"
while IFS= read -r secret; do
  assert_docs_contains "$secret"
done <<<"$expected_secrets"
while IFS= read -r variable; do
  assert_docs_contains "$variable"
done <<<"$expected_variables"

cleanup_test_fixtures
trap - EXIT

printf 'provision-ios-runner.test.sh: all cases passed\n'
