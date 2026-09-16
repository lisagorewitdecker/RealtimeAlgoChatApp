#!/usr/bin/env bash
#
# Validate the iOS Expo Go preview handoff record. Public reachability and
# local Metro readiness are separate from evidence that a physical iPhone
# launched Expo Go and made the native request.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
RECORD_ROOT="$ROOT_DIR/artifacts/chat-app/test-results/encrypted-room-recovery/ios"
RECORD_PATH="${1:-}"
PREFLIGHT_PATH="${2:-}"
PREFLIGHT_PATH_EXPLICIT=0
[[ -n "$PREFLIGHT_PATH" ]] && PREFLIGHT_PATH_EXPLICIT=1
FAILURES=()

failure() {
  FAILURES+=("$1")
}

table_value() {
  local field="$1"
  awk -F'|' -v expected="$field" '
    {
      label = $2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", label)
    }
    label == expected {
      value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$RECORD_PATH"
}

boundary_row() {
  local boundary="$1"
  awk -F'|' -v expected="$boundary" '
    {
      label = $2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", label)
    }
    label == expected {
      print
      exit
    }
  ' "$RECORD_PATH"
}

boundary_status() {
  local boundary="$1"
  local row
  row="$(boundary_row "$boundary")"
  [[ -n "$row" ]] || return 0
  awk -F'|' '{
    value = $3
    gsub(/\*/, "", value)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    print tolower(value)
  }' <<<"$row"
}

require_handoff_boundary() {
  local boundary="$1"
  if [[ -z "$(boundary_row "$boundary")" ]]; then
    failure "iOS preview evidence records must include the '${boundary}' boundary row."
  fi
}

validate_boundary_status() {
  local boundary="$1"
  shift
  local status allowed
  status="$(boundary_status "$boundary")"
  if [[ -z "$status" ]]; then
    failure "The '${boundary}' boundary row must have a non-empty status."
    return
  fi
  for allowed in "$@"; do
    [[ "$status" == "$allowed" ]] && return
  done
  failure "The '${boundary}' boundary row has an unsupported status."
}

validate_handoff_boundaries() {
  require_handoff_boundary "Public manifest reachability"
  require_handoff_boundary "Local handoff probe (manifest and bundle)"
  require_handoff_boundary "Expo Go launch on physical iPhone"
  require_handoff_boundary "Server-side native request evidence"

  validate_boundary_status "Public manifest reachability" pass fail not_run
  validate_boundary_status \
    "Local handoff probe (manifest and bundle)" \
    pass fail not_run
  validate_boundary_status "Expo Go launch on physical iPhone" pass fail blocked
  validate_boundary_status \
    "Server-side native request evidence" \
    pass fail blocked
}

validate_preflight_json() {
  local preflight_path="$1"
  local status_output actual_status expected_status boundary

  if [[ -z "$preflight_path" ]]; then
    return
  fi
  if [[ ! -f "$preflight_path" ]]; then
    if ((PREFLIGHT_PATH_EXPLICIT)); then
      failure "The iOS preview preflight JSON artifact does not exist."
    fi
    return
  fi

  if ! status_output="$(
    node "$ROOT_DIR/artifacts/chat-app/scripts/validate-preview-startup.mjs" \
      --validate-record "$preflight_path" 2>/dev/null
  )"; then
    failure "The iOS preview preflight JSON artifact does not satisfy the redacted schema."
    return
  fi

  for boundary in \
    "publicManifestReachability" \
    "localHandoffProbe" \
    "expoGoLaunch" \
    "serverNativeRequestEvidence"; do
    actual_status="$(
      printf '%s\n' "$status_output" |
        awk -F= -v expected="$boundary" '$1 == expected { print tolower($2); exit }'
    )"
    if [[ -z "$actual_status" ]]; then
      failure "The iOS preview preflight JSON artifact is missing a required boundary."
      return
    fi
  done

  expected_status="$(boundary_status "Public manifest reachability")"
  actual_status="$(
    printf '%s\n' "$status_output" |
      awk -F= '$1 == "publicManifestReachability" { print tolower($2); exit }'
  )"
  [[ "$actual_status" == "$expected_status" ]] ||
    failure "The preflight JSON public manifest boundary does not match the Markdown record."

  expected_status="$(boundary_status "Local handoff probe (manifest and bundle)")"
  actual_status="$(
    printf '%s\n' "$status_output" |
      awk -F= '$1 == "localHandoffProbe" { print tolower($2); exit }'
  )"
  [[ "$actual_status" == "$expected_status" ]] ||
    failure "The preflight JSON local handoff boundary does not match the Markdown record."
}

is_missing_metadata() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  value="${value//\*/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -z "$value" ||
    "$value" == *blocked* ||
    "$value" == *unavailable* ||
    "$value" == *"not available"* ||
    "$value" == *"not provided"* ||
    "$value" == *"not recorded"* ||
    "$value" == *"not captured"* ||
    "$value" == *pending* ||
    "$value" == *"no physical"* ||
    "$value" == *"no expo go"* ||
    "$value" == "todo" ||
    "$value" == "unknown" ||
    "$value" == "none" ||
    "$value" == "null" ||
    "$value" == "-" ||
    "$value" == "--" ||
    "$value" == "placeholder" ||
    "$value" == *"n/a"* ||
    "$value" == '<'*'>' ]]
}

validate_native_request() {
  local native_row native_lower
  native_row="$(boundary_row "Server-side native request evidence")"
  native_lower="$(printf '%s' "$native_row" | tr '[:upper:]' '[:lower:]')"
  if [[ "$(boundary_status "Server-side native request evidence")" != "pass" ||
    "$native_lower" != *"native request evidence"* ||
    "$native_lower" != *"platform=ios"* ||
    ( "$native_lower" != *"client=expo go"* && "$native_lower" != *"expo go user-agent"* ) ||
    "$native_lower" == *"curl"* ||
    "$native_lower" == *"workspace"* ||
    "$native_lower" == *"platform=-"* ||
    "$native_lower" == *"options"* ||
    "$native_lower" == *"preflight"* ||
    "$native_lower" == *"browser"* ||
    "$native_lower" == *"startup"* ]]; then
    failure "PASS records require native iOS/Expo Go request evidence; workspace curl output is insufficient."
  fi
}

validate_pass_record() {
  local field value public_status local_status launch_status
  for field in "Device model" "iOS version" "Expo Go version"; do
    value="$(table_value "$field")"
    if is_missing_metadata "$value"; then
      failure "PASS records must include a real ${field} value."
    fi
  done

  public_status="$(boundary_status "Public manifest reachability")"
  local_status="$(boundary_status "Local handoff probe (manifest and bundle)")"
  launch_status="$(boundary_status "Expo Go launch on physical iPhone")"
  [[ "$public_status" == "pass" ]] ||
    failure "PASS records must mark public manifest reachability as PASS."
  [[ "$local_status" == "pass" ]] ||
    failure "PASS records must mark the local manifest and bundle probe as PASS."
  [[ "$launch_status" == "pass" ]] ||
    failure "PASS records must mark the stock Expo Go iOS launch boundary as PASS."
  validate_native_request
}

validate_blocked_record() {
  local public_status launch_status native_status
  public_status="$(boundary_status "Public manifest reachability")"
  launch_status="$(boundary_status "Expo Go launch on physical iPhone")"
  native_status="$(boundary_status "Server-side native request evidence")"

  if [[ "$public_status" == "fail" ]]; then
    failure "A public-edge FAIL must use Result: FAIL; it is not a missing iPhone evidence BLOCKED result."
    return
  fi
  if [[ "$public_status" != "pass" ]]; then
    failure "BLOCKED records must mark public manifest reachability as PASS."
  fi
  if [[ "$launch_status" != "blocked" && "$native_status" != "blocked" ]]; then
    failure "BLOCKED records must identify the unavailable physical iPhone or native request boundary."
  fi
}

validate_public_edge_failure() {
  local public_status local_status
  public_status="$(boundary_status "Public manifest reachability")"
  local_status="$(boundary_status "Local handoff probe (manifest and bundle)")"
  if [[ "$public_status" != "fail" ]]; then
    failure "FAIL records must identify a public manifest reachability FAIL."
  fi
  if [[ "$local_status" != "not_run" ]]; then
    failure "Public-edge FAIL records must mark the local handoff probe as NOT_RUN."
  fi
}

if [[ -z "$RECORD_PATH" ]]; then
  RECORD_PATH="$(
    find "$RECORD_ROOT" \
      -mindepth 2 -maxdepth 2 \
      -type f -name validation-record.md -print 2>/dev/null |
      sort | tail -n 1
  )"
fi

if [[ -z "$RECORD_PATH" ]]; then
  failure "No iOS preview evidence record was found under ${RECORD_ROOT}."
elif [[ ! -f "$RECORD_PATH" ]]; then
  failure "iOS preview evidence record does not exist."
else
  if [[ -z "$PREFLIGHT_PATH" ]]; then
    PREFLIGHT_PATH="$(dirname "$RECORD_PATH")/ios-preview-preflight.json"
  fi
  validate_preflight_json "$PREFLIGHT_PATH"
  validate_handoff_boundaries
  result="$(sed -nE 's/^\*\*Result:[[:space:]]*(PASS|BLOCKED|FAIL).*/\1/p' "$RECORD_PATH" | head -n 1)"
  case "$result" in
    PASS)
      validate_pass_record
      ;;
    BLOCKED)
      validate_blocked_record
      ;;
    FAIL)
      validate_public_edge_failure
      ;;
    "")
      failure "Evidence record must declare **Result: PASS**, **Result: BLOCKED**, or **Result: FAIL**."
      ;;
    *)
      failure "Evidence record has an unsupported result; use PASS, BLOCKED, or FAIL."
      ;;
  esac
fi

if ((${#FAILURES[@]})); then
  printf 'iOS preview evidence validation FAILED with %d issue(s).\n' "${#FAILURES[@]}" >&2
  printf -- '- %s\n' "${FAILURES[@]}" >&2
  exit 1
fi

printf 'iOS preview evidence validation passed: %s\n' "$RECORD_PATH"