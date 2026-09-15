#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-android-preview-evidence.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'Expected output to contain %s.\n%s\n' "$needle" "$haystack" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'Expected output not to contain %s.\n%s\n' "$needle" "$haystack" >&2
    exit 1
  fi
}

write_record() {
  local path="$1"
  cat >"$path"
}

blocked_record="$TEST_ROOT/blocked/validation-record.md"
mkdir -p "$(dirname "$blocked_record")"
write_record "$blocked_record" <<'EOF'
# Android SDK 57 preview validation record

**Result: BLOCKED — no physical Android handoff was available**

## Metadata

| Field | Result |
| --- | --- |
| Device model | **BLOCKED** — no physical Android device was available |
| Android version | **BLOCKED** — no physical Android device was available |
| Expo Go version | **BLOCKED** — no Expo Go session was available |

## Boundary results

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public preview host reachable | PASS | Workspace curl returned HTTP 200. |
| Fresh preview opened in stock Expo Go on Android | **BLOCKED** | No physical phone was available. |
| Expo Go session launch observed at Metro | **BLOCKED** | No native Android request was available. |
EOF
blocked_output="$(bash "$CHECKER" "$blocked_record" 2>&1)"
assert_contains "$blocked_output" "validation passed"

pass_record="$TEST_ROOT/pass/validation-record.md"
mkdir -p "$(dirname "$pass_record")/screenshots"
printf '%s' \
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' |
  base64 --decode >"$(dirname "$pass_record")/screenshots/preview-launch.png"
write_record "$pass_record" <<'EOF'
# Android SDK 57 preview validation record

**Result: PASS — physical Android preview handoff observed**

## Metadata

| Field | Result |
| --- | --- |
| Device model | Pixel 8a |
| Android version | Android 15 |
| Expo Go version | 2.35.7 |

## Boundary results

| Boundary | Status | Evidence |
| --- | --- | --- |
| Fresh preview opened in stock Expo Go on Android | PASS | Landing screen rendered. |
| Expo Go session launch observed at Metro | PASS | Native request evidence: platform=android; client=Expo Go; user-agent=[redacted] |
| Redacted screenshot or exact phone error captured | PASS | Redacted screenshot: screenshots/preview-launch.png |
| Screenshot redaction review | PASS | Redaction review: PASS — account identifiers, message content, tokens, and host details are absent. |
EOF
pass_output="$(bash "$CHECKER" "$pass_record" 2>&1)"
assert_contains "$pass_output" "validation passed"

phone_error_record="$TEST_ROOT/phone-error/validation-record.md"
mkdir -p "$(dirname "$phone_error_record")"
sed \
  -e 's#Redacted screenshot: screenshots/preview-launch.png#Exact phone error: "There was a problem running the requested project."#' \
  "$pass_record" >"$phone_error_record"
phone_error_output="$(bash "$CHECKER" "$phone_error_record" 2>&1)"
assert_contains "$phone_error_output" "validation passed"

for field in "Device model" "Android version" "Expo Go version"; do
  for placeholder in TODO unknown none - placeholder pending blocked; do
    missing_metadata="$TEST_ROOT/missing-${field// /-}-${placeholder// /-}.md"
    awk -F'|' -v target="$field" -v replacement="$placeholder" '
      {
        label = $2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", label)
        if (label == target) {
          print "| " target " | " replacement " |"
          next
        }
        print
      }
    ' "$pass_record" >"$missing_metadata"
    if missing_output="$(bash "$CHECKER" "$missing_metadata" 2>&1)"; then
      printf 'PASS record with %s=%s unexpectedly passed.\n' "$field" "$placeholder" >&2
      exit 1
    fi
    assert_contains "$missing_output" "PASS records must include a real ${field} value."
  done
done

curl_only="$TEST_ROOT/curl-only.md"
sed 's/Native request evidence: platform=android; client=Expo Go; user-agent=\[redacted\]/Workspace curl output: platform=-; ua=curl\/8.14.1/' \
  "$pass_record" >"$curl_only"
if curl_output="$(bash "$CHECKER" "$curl_only" 2>&1)"; then
  printf 'PASS record with workspace curl evidence unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$curl_output" "workspace curl output is insufficient"

conflicting_native="$TEST_ROOT/conflicting-native.md"
sed 's/Native request evidence: platform=android; client=Expo Go; user-agent=\[redacted\]/Native request evidence: browser OPTIONS preflight; platform=-; platform=android; client=Expo Go; user-agent=[redacted]/' \
  "$pass_record" >"$conflicting_native"
if conflicting_output="$(bash "$CHECKER" "$conflicting_native" 2>&1)"; then
  printf 'PASS record with prohibited browser markers unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$conflicting_output" "workspace curl output is insufficient"

missing_screenshot="$TEST_ROOT/missing-screenshot.md"
sed 's#screenshots/preview-launch.png#screenshots/missing.png#' \
  "$pass_record" >"$missing_screenshot"
if screenshot_output="$(bash "$CHECKER" "$missing_screenshot" 2>&1)"; then
  printf 'PASS record with a missing screenshot unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$screenshot_output" "redacted screenshot path must point to an existing non-empty supported image file"

empty_screenshot="$TEST_ROOT/empty-screenshot.md"
mkdir -p "$(dirname "$empty_screenshot")/screenshots"
touch "$(dirname "$empty_screenshot")/screenshots/empty.png"
sed 's#screenshots/preview-launch.png#screenshots/empty.png#' \
  "$pass_record" >"$empty_screenshot"
if empty_output="$(bash "$CHECKER" "$empty_screenshot" 2>&1)"; then
  printf 'PASS record with an empty screenshot unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$empty_output" "redacted screenshot path must point to an existing non-empty supported image file"

truncated_screenshot="$TEST_ROOT/truncated-screenshot.md"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' \
  >"$(dirname "$truncated_screenshot")/screenshots/truncated.png"
sed 's#screenshots/preview-launch.png#screenshots/truncated.png#' \
  "$pass_record" >"$truncated_screenshot"
if truncated_output="$(bash "$CHECKER" "$truncated_screenshot" 2>&1)"; then
  printf 'PASS record with a truncated PNG unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$truncated_output" "redacted screenshot path must point to an existing non-empty supported image file"

tiny_jpeg="$TEST_ROOT/tiny-jpeg.md"
printf '\xff\xd8\xff\xd9' >"$(dirname "$tiny_jpeg")/screenshots/tiny.jpg"
sed 's#screenshots/preview-launch.png#screenshots/tiny.jpg#' \
  "$pass_record" >"$tiny_jpeg"
if tiny_jpeg_output="$(bash "$CHECKER" "$tiny_jpeg" 2>&1)"; then
  printf 'PASS record with a tiny JPEG unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$tiny_jpeg_output" "redacted screenshot path must point to an existing non-empty supported image file"

tiny_webp="$TEST_ROOT/tiny-webp.md"
printf 'RIFF\x00\x00\x00\x00WEBP' >"$(dirname "$tiny_webp")/screenshots/tiny.webp"
sed 's#screenshots/preview-launch.png#screenshots/tiny.webp#' \
  "$pass_record" >"$tiny_webp"
if tiny_webp_output="$(bash "$CHECKER" "$tiny_webp" 2>&1)"; then
  printf 'PASS record with a tiny WebP unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$tiny_webp_output" "redacted screenshot path must point to an existing non-empty supported image file"

non_image="$TEST_ROOT/non-image.md"
mkdir -p "$(dirname "$non_image")/screenshots"
printf 'not an image' >"$(dirname "$non_image")/screenshots/not-image.png"
sed 's#screenshots/preview-launch.png#screenshots/not-image.png#' \
  "$pass_record" >"$non_image"
if non_image_output="$(bash "$CHECKER" "$non_image" 2>&1)"; then
  printf 'PASS record with a non-image screenshot unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$non_image_output" "redacted screenshot path must point to an existing non-empty supported image file"

missing_redaction_review="$TEST_ROOT/missing-redaction-review.md"
mkdir -p "$(dirname "$missing_redaction_review")/screenshots"
cp "$(dirname "$pass_record")/screenshots/preview-launch.png" \
  "$(dirname "$missing_redaction_review")/screenshots/preview-launch.png"
sed '/| Screenshot redaction review |/d' "$pass_record" >"$missing_redaction_review"
if missing_review_output="$(bash "$CHECKER" "$missing_redaction_review" 2>&1)"; then
  printf 'PASS record with no screenshot redaction review unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$missing_review_output" "separate Screenshot redaction review row marked PASS"

write_png_with_text() {
  local output_path="$1"
  local text="$2"
  node - "$output_path" "$text" <<'NODE'
const fs = require("node:fs");

const [, , outputPath, text] = process.argv;
const base = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const iend = base.subarray(base.length - 12);
const textData = Buffer.from(`tEXt${text}`, "utf8");
const length = Buffer.alloc(4);
length.writeUInt32BE(textData.length);
const textChunk = Buffer.concat([length, textData, Buffer.alloc(4)]);
fs.writeFileSync(outputPath, Buffer.concat([base.subarray(0, base.length - 12), textChunk, iend]));
NODE
}

declare -A forbidden_fixtures=(
  [account]='account_email=preview-fixture@example.test'
  [message]='message_body=preview-fixture-message'
  [token]='Authorization: Bearer preview-fixture-token-123456'
  [host]='host=https://preview-fixture.replit.dev'
)
for category in account message token host; do
  forbidden_record="$TEST_ROOT/forbidden-${category}.md"
  forbidden_screenshot="$(dirname "$forbidden_record")/screenshots/forbidden-${category}.png"
  mkdir -p "$(dirname "$forbidden_screenshot")"
  write_png_with_text "$forbidden_screenshot" "${forbidden_fixtures[$category]}"
  sed "s#screenshots/preview-launch.png#screenshots/forbidden-${category}.png#" \
    "$pass_record" >"$forbidden_record"
  if forbidden_output="$(bash "$CHECKER" "$forbidden_record" 2>&1)"; then
    printf 'PASS record with forbidden %s screenshot content unexpectedly passed.\n' "$category" >&2
    exit 1
  fi
  assert_contains "$forbidden_output" "forbidden ${category}"
  assert_not_contains "$forbidden_output" "${forbidden_fixtures[$category]}"
done

for placeholder in "" TODO pending blocked placeholder -; do
  empty_phone_error="$TEST_ROOT/phone-error-${placeholder:-empty}.md"
  sed "s/There was a problem running the requested project./${placeholder}/" \
    "$phone_error_record" >"$empty_phone_error"
  if empty_error_output="$(bash "$CHECKER" "$empty_phone_error" 2>&1)"; then
    printf 'PASS record with phone error %s unexpectedly passed.\n' "${placeholder:-empty}" >&2
    exit 1
  fi
  assert_contains "$empty_error_output" "non-placeholder exact phone error"
done

decorated_phone_error="$TEST_ROOT/decorated-phone-error.md"
sed 's/There was a problem running the requested project./**BLOCKED** — not captured/' \
  "$phone_error_record" >"$decorated_phone_error"
if decorated_error_output="$(bash "$CHECKER" "$decorated_phone_error" 2>&1)"; then
  printf 'PASS record with a decorated missing phone error unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$decorated_error_output" "non-placeholder exact phone error"

unclear_blocked="$TEST_ROOT/unclear-blocked.md"
sed \
  -e 's/No physical phone was available./The handoff was not completed./' \
  -e 's/No native Android request was available./The handoff was not completed./' \
  "$blocked_record" >"$unclear_blocked"
if unclear_output="$(bash "$CHECKER" "$unclear_blocked" 2>&1)"; then
  printf 'BLOCKED record without a missing-boundary explanation unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$unclear_output" "BLOCKED records must identify the unavailable physical or native boundary"
assert_not_contains "$unclear_output" "No physical phone was available"

unrelated_blocked="$TEST_ROOT/unrelated-blocked.md"
sed \
  -e 's#| Fresh preview opened in stock Expo Go on Android | \*\*BLOCKED\*\* |.*#| Fresh preview opened in stock Expo Go on Android | PASS | Landing screen rendered. |#' \
  -e 's#| Phone model, Android version, and Expo Go version captured | \*\*BLOCKED\*\* |.*#| Phone model, Android version, and Expo Go version captured | PASS | Metadata captured. |#' \
  -e 's#| Expo Go session launch observed at Metro | \*\*BLOCKED\*\* |.*#| Expo Go session launch observed at Metro | PASS | Native request observed. |#' \
  -e 's#| Redacted screenshot or exact phone error captured | \*\*BLOCKED\*\* |.*#| Redacted screenshot or exact phone error captured | PASS | Evidence captured. |#' \
  "$blocked_record" >"$unrelated_blocked"
printf '%s\n' '| Unrelated bookkeeping | **BLOCKED** | no physical archive copy available. |' \
  >>"$unrelated_blocked"
if unrelated_output="$(bash "$CHECKER" "$unrelated_blocked" 2>&1)"; then
  printf 'BLOCKED record with only an unrelated blocker unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$unrelated_output" "required Android preview row"

echo "Android preview evidence regression tests passed."