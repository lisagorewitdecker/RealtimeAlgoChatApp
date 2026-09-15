#!/usr/bin/env bash
#
# Validate the Android Expo Go preview evidence record without treating public
# reachability as a device launch. This is intentionally a small Markdown
# contract check so it can run before a reviewer relies on the record.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
RECORD_ROOT="$ROOT_DIR/artifacts/chat-app/test-results/encrypted-room-recovery/android"
RECORD_PATH="${1:-}"
FAILURES=()

failure() {
  FAILURES+=("$1")
}

table_value() {
  local field="$1"
  awk -F'|' -v expected="$field" '
    $2 ~ "^[[:space:]]*" expected "[[:space:]]*$" {
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
    $2 ~ "^[[:space:]]*" expected "[[:space:]]*$" {
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
  awk -F'|' '{ value = $3; gsub(/\*/,"",value); gsub(/^[[:space:]]+|[[:space:]]+$/,"",value); print tolower(value) }' <<<"$row"
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

is_supported_image_file() {
  local image_path="$1"
  local header riff_tag image_size chunk_type trailer
  local ihdr_length jpeg_hex has_sof riff_length chunk_length
  [[ -s "$image_path" ]] || return 1

  header="$(od -An -tx1 -N16 "$image_path" | tr -d '[:space:]')"
  if [[ "$header" == 89504e470d0a1a0a* ]]; then
    image_size="$(wc -c <"$image_path")"
    ((image_size >= 45)) || return 1
    ihdr_length="$(od -An -tx1 -j8 -N4 "$image_path" | tr -d '[:space:]')"
    chunk_type="$(dd if="$image_path" bs=1 skip=12 count=4 2>/dev/null)"
    trailer="$(tail -c 12 "$image_path" | od -An -tx1 | tr -d '[:space:]')"
    [[ "$ihdr_length" == "0000000d" &&
      "$chunk_type" == "IHDR" &&
      "$trailer" == "0000000049454e44ae426082" ]]
    return
  fi

  if [[ "$header" == ffd8ff* ]]; then
    image_size="$(wc -c <"$image_path")"
    ((image_size >= 100)) || return 1
    jpeg_hex="$(od -An -tx1 "$image_path" | tr -d '[:space:]')"
    trailer="$(tail -c 2 "$image_path" | od -An -tx1 | tr -d '[:space:]')"
    [[ "$jpeg_hex" == ffd8* &&
      "$jpeg_hex" == *ffdb* &&
      "$jpeg_hex" == *ffda* &&
      "$trailer" == "ffd9" ]] || return 1
    has_sof=0
    for marker in ffc0 ffc1 ffc2 ffc3 ffc5 ffc6 ffc7 ffc9 ffca ffcb ffcd ffce ffcf; do
      if [[ "$jpeg_hex" == *"$marker"* ]]; then
        has_sof=1
        break
      fi
    done
    ((has_sof))
    return
  fi

  if [[ "$header" == 52494646* ]]; then
    image_size="$(wc -c <"$image_path")"
    ((image_size >= 20)) || return 1
    riff_length="$(od -An -tx1 -j4 -N4 "$image_path" | tr -d '[:space:]')"
    riff_length=$((16#${riff_length:6:2}${riff_length:4:2}${riff_length:2:2}${riff_length:0:2}))
    ((riff_length == image_size - 8)) || return 1
    riff_tag="$(dd if="$image_path" bs=1 skip=8 count=4 2>/dev/null)"
    chunk_type="$(dd if="$image_path" bs=1 skip=12 count=4 2>/dev/null)"
    chunk_length="$(od -An -tx1 -j16 -N4 "$image_path" | tr -d '[:space:]')"
    chunk_length=$((16#${chunk_length:6:2}${chunk_length:4:2}${chunk_length:2:2}${chunk_length:0:2}))
    [[ "$riff_tag" == "WEBP" &&
      ( "$chunk_type" == "VP8 " || "$chunk_type" == "VP8L" || "$chunk_type" == "VP8X" ) ]] || return 1
    ((chunk_length + 20 <= image_size))
    return 0
  fi

  return 1
}

screenshot_contains_forbidden_text() {
  local image_path="$1"
  local pattern="$2"
  strings -a -n 4 "$image_path" 2>/dev/null |
    LC_ALL=C grep -Eiq -- "$pattern"
}

validate_screenshot_redaction() {
  local screenshot_file="$1"
  local category

  if screenshot_contains_forbidden_text "$screenshot_file" \
    '[[:alnum:]][[:alnum:]._%+-]*@[[:alnum:].-]+\.[[:alpha:]]{2,}|(account|user(name)?|member|profile)[[:space:]_-]*(id|email|name)?[[:space:]]*[:=]'; then
    failure "The PASS record's screenshot contains forbidden account identifier content; replace it with a reviewed redacted capture."
  fi

  if screenshot_contains_forbidden_text "$screenshot_file" \
    'message[[:space:]_-]*(body|content|text)?[[:space:]]*[:=]|plaintext[[:space:]_-]*(body|content|text)?[[:space:]]*[:=]|conversation[[:space:]_-]*(body|content|text)?[[:space:]]*[:=]'; then
    failure "The PASS record's screenshot contains forbidden message content; replace it with a reviewed redacted capture."
  fi

  if screenshot_contains_forbidden_text "$screenshot_file" \
    'bearer[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(^|[^[:alpha:]])(auth|access|refresh|session|api)?[_-]?token[[:space:]]*(value)?[[:space:]]*[:=]'; then
    failure "The PASS record's screenshot contains forbidden token content; replace it with a reviewed redacted capture."
  fi

  if screenshot_contains_forbidden_text "$screenshot_file" \
    '(https?|wss?|exp)://|(^|[^[:alpha:]])(host|hostname|origin)[[:space:]]*[:=]|localhost([:/]|$)|[[:alnum:].-]+\.(replit\.dev|repl\.co|replit\.app)([^[:alnum:].-]|$)'; then
    failure "The PASS record's screenshot contains forbidden host details; replace it with a reviewed redacted capture."
  fi
}

is_meaningful_phone_error() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  value="${value//\*/}"
  value="${value//\`/}"
  value="${value//_/ }"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" &&
    "$value" != "--" &&
    "$value" != "n/a" &&
    "$value" != "na" &&
    "$value" != "none" &&
    "$value" != "null" &&
    "$value" != "unknown" &&
    "$value" != "todo" &&
    "$value" != "pending" &&
    "$value" != "blocked" &&
    "$value" != "-" &&
    "$value" != "placeholder" &&
    "$value" != "unavailable" &&
    "$value" != "not provided" &&
    "$value" != "not recorded" &&
    "$value" != "not available" &&
    "$value" != "not captured" &&
    "$value" != *blocked* &&
    "$value" != *unavailable* &&
    "$value" != *"not available"* &&
    "$value" != *"not captured"* &&
    "$value" != *pending* &&
    "$value" != *placeholder* &&
    "$value" != *todo* &&
    "$value" != *unknown* &&
    "$value" != '<'*'>' ]]
}

validate_pass_record() {
  local field value
  for field in "Device model" "Android version" "Expo Go version"; do
    value="$(table_value "$field")"
    if is_missing_metadata "$value"; then
      failure "PASS records must include a real ${field} value."
    fi
  done

  local launch_status
  launch_status="$(boundary_status "Fresh preview opened in stock Expo Go on Android")"
  if [[ "$launch_status" != "pass" ]]; then
    failure "PASS records must mark the stock Expo Go Android launch boundary as PASS."
  fi

  local native_row native_lower
  native_row="$(boundary_row "Expo Go session launch observed at Metro")"
  native_lower="$(printf '%s' "$native_row" | tr '[:upper:]' '[:lower:]')"
  if [[ "$(boundary_status "Expo Go session launch observed at Metro")" != "pass" ||
    "$native_lower" != *"native request evidence"* ||
    "$native_lower" != *"platform=android"* ||
    ( "$native_lower" != *"client=expo go"* && "$native_lower" != *"expo go user-agent"* ) ||
    "$native_lower" == *"curl"* ||
    "$native_lower" == *"workspace"* ||
    "$native_lower" == *"platform=-"* ||
    "$native_lower" == *"options"* ||
    "$native_lower" == *"preflight"* ||
    "$native_lower" == *"browser"* ||
    "$native_lower" == *"startup"* ]]; then
    failure "PASS records require native Android/Expo Go request evidence; workspace curl output is insufficient."
  fi

  local result_row result_lower screenshot_path screenshot_file redaction_row
  result_row="$(boundary_row "Redacted screenshot or exact phone error captured")"
  result_lower="$(printf '%s' "$result_row" | tr '[:upper:]' '[:lower:]')"
  if [[ "$(boundary_status "Redacted screenshot or exact phone error captured")" != "pass" ]]; then
    failure "PASS records require a redacted screenshot or an exact phone error."
  elif [[ "$result_lower" == *"redacted screenshot:"* ]]; then
    screenshot_path="$(printf '%s' "$result_row" | sed -nE 's#.*[Rr]edacted screenshot:[[:space:]]*`?([^`|[:space:]]+).*#\1#p' | head -n 1)"
    screenshot_file="$(dirname "$RECORD_PATH")/$screenshot_path"
    if [[ -z "$screenshot_path" ||
      "$screenshot_path" != screenshots/* ||
      "$screenshot_path" == *..* ||
      ! -f "$screenshot_file" ]] ||
      ! is_supported_image_file "$screenshot_file"; then
      failure "The PASS record's redacted screenshot path must point to an existing non-empty supported image file."
    else
      redaction_row="$(boundary_row "Screenshot redaction review")"
      if [[ "$(boundary_status "Screenshot redaction review")" != "pass" ]]; then
        failure "PASS records with a screenshot require a separate Screenshot redaction review row marked PASS."
      fi
      validate_screenshot_redaction "$screenshot_file"
    fi
  else
    phone_error="$(printf '%s' "$result_row" | awk -F'|' '
      {
        value = $4
        sub(/^[[:space:]]*[Ee]xact phone error:[[:space:]]*/, "", value)
        gsub(/[[:space:]]+$/, "", value)
        print value
      }
    ')"
    if [[ "$result_lower" != *"exact phone error:"* ]] ||
      ! is_meaningful_phone_error "$phone_error"; then
      failure "PASS records require a non-placeholder exact phone error when no screenshot is supplied."
    fi
  fi
}

validate_blocked_record() {
  local blocked_boundary=""
  local boundary row lower
  for boundary in \
    "Fresh preview opened in stock Expo Go on Android" \
    "Phone model, Android version, and Expo Go version captured" \
    "Expo Go session launch observed at Metro" \
    "Redacted screenshot or exact phone error captured"; do
    row="$(boundary_row "$boundary")"
    lower="$(printf '%s' "$row" | tr '[:upper:]' '[:lower:]' | tr -d '*')"
    if [[ "$lower" == *"| blocked |"* &&
      ( "$lower" == *"no physical"* ||
        "$lower" == *"not available"* ||
        "$lower" == *"unavailable"* ||
        "$lower" == *"missing"* ||
        "$lower" == *"not captured"* ||
        "$lower" == *"no native"* ) ]]; then
      blocked_boundary=1
      break
    fi
  done

  if [[ -z "$blocked_boundary" ]]; then
    failure "BLOCKED records must identify the unavailable physical or native boundary on a required Android preview row."
  fi
}

if [[ -z "$RECORD_PATH" ]]; then
  RECORD_PATH="$(
    find "$RECORD_ROOT" \
      -mindepth 2 \
      -maxdepth 2 \
      -type f \
      -name validation-record.md \
      -print 2>/dev/null |
      sort |
      tail -n 1
  )"
fi

if [[ -z "$RECORD_PATH" ]]; then
  failure "No Android preview evidence record was found under ${RECORD_ROOT}."
elif [[ ! -f "$RECORD_PATH" ]]; then
  failure "Android preview evidence record does not exist."
else
  result="$(sed -nE 's/^\*\*Result:[[:space:]]*(PASS|BLOCKED|FAIL).*/\1/p' "$RECORD_PATH" | head -n 1)"
  case "$result" in
    PASS)
      validate_pass_record
      ;;
    BLOCKED)
      validate_blocked_record
      ;;
    "")
      failure "Evidence record must declare **Result: PASS** or **Result: BLOCKED**."
      ;;
    *)
      failure "Evidence record has an unsupported result; use PASS or BLOCKED."
      ;;
  esac
fi

if ((${#FAILURES[@]})); then
  printf 'Android preview evidence validation FAILED with %d issue(s).\n' "${#FAILURES[@]}" >&2
  printf -- '- %s\n' "${FAILURES[@]}" >&2
  exit 1
fi

printf 'Android preview evidence validation passed: %s\n' "$RECORD_PATH"