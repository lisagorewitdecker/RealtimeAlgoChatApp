#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check-android-preview-evidence.sh"
VALIDATOR="$ROOT_DIR/artifacts/chat-app/scripts/validate-preview-startup.mjs"
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

write_preflight() {
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
| Public manifest reachability | PASS | Workspace curl returned HTTP 200. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local probe was not run. |
| Expo Go launch on physical Android | **BLOCKED** | No physical phone was available. |
| Server-side native request evidence | **BLOCKED** | No native Android request was available. |
EOF
blocked_preflight="$(dirname "$blocked_record")/android-preview-preflight.json"
write_preflight "$blocked_preflight" <<'EOF'
{
  "schema": "android-preview-handoff-preflight/v1",
  "platform": "android",
  "boundaries": {
    "publicManifestReachability": {
      "status": "PASS",
      "evidence": "public manifest HTTP 200 (128 bytes)"
    },
    "localHandoffProbe": {
      "status": "NOT_RUN",
      "evidence": "Local manifest/bundle probe not run — no successful probe result was recorded"
    },
    "expoGoLaunch": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires a physical Android phone running stock Expo Go."
    },
    "serverNativeRequestEvidence": {
      "status": "NOT_ASSESSED",
      "evidence": "Requires filtered Metro or API evidence from that physical Expo Go session."
    }
  }
}
EOF
blocked_output="$(bash "$CHECKER" "$blocked_record" 2>&1)"
assert_contains "$blocked_output" "validation passed"

json_contract_root="$TEST_ROOT/json-contract"
json_contract_record="$json_contract_root/validation-record.md"
mkdir -p "$json_contract_root"
cp "$blocked_record" "$json_contract_record"
json_contract_path="$json_contract_root/android-preview-preflight.json"

cat >"$json_contract_path" <<'EOF'
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"GARBAGE","evidence":"safe"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"safe"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"safe"},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"safe"}}}
EOF
if invalid_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Malformed Android preflight JSON unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$invalid_json_output" "does not satisfy the redacted schema"
assert_not_contains "$invalid_json_output" "GARBAGE"

truncated_json_sentinel="android-preview-truncated-preflight-sentinel"
cat >"$json_contract_path" <<EOF
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"$truncated_json_sentinel"
EOF
if truncated_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Truncated Android preflight JSON unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$truncated_json_output" "does not satisfy the redacted schema"
assert_not_contains "$truncated_json_output" "$truncated_json_sentinel"
if truncated_json_direct_output="$(
  node "$VALIDATOR" --validate-record "$json_contract_path" 2>&1
)"; then
  printf 'Truncated Android preflight JSON unexpectedly passed direct validation.\n' >&2
  exit 1
fi
assert_contains "$truncated_json_direct_output" \
  "Preview handoff preflight JSON is not valid JSON."
assert_not_contains "$truncated_json_direct_output" "$truncated_json_sentinel"

non_json_sentinel="android-preview-non-json-preflight-sentinel"
cat >"$json_contract_path" <<EOF
$non_json_sentinel
This is not a JSON preflight record.
EOF
if non_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Non-JSON Android preflight content unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$non_json_output" "does not satisfy the redacted schema"
assert_not_contains "$non_json_output" "$non_json_sentinel"
if non_json_direct_output="$(
  node "$VALIDATOR" --validate-record "$json_contract_path" 2>&1
)"; then
  printf 'Non-JSON Android preflight content unexpectedly passed direct validation.\n' >&2
  exit 1
fi
assert_contains "$non_json_direct_output" \
  "Preview handoff preflight JSON is not valid JSON."
assert_not_contains "$non_json_direct_output" "$non_json_sentinel"

unreadable_json_sentinel="android-preview-unreadable-preflight-sentinel"
unreadable_root="$TEST_ROOT/unreadable-json"
unreadable_record="$unreadable_root/validation-record.md"
unreadable_json_path="$unreadable_root/android-preview-preflight.json"
mkdir -p "$unreadable_root"
cp "$blocked_record" "$unreadable_record"
cat >"$unreadable_json_path" <<EOF
{"schema":"android-preview-handoff-preflight/v1","platform":"android","sentinel":"$unreadable_json_sentinel"}
EOF
chmod 000 "$unreadable_json_path"

if ((EUID == 0)); then
  if ! command -v runuser >/dev/null 2>&1; then
    printf 'Unreadable Android preflight fixture requires runuser when tests run as root.\n' >&2
    exit 1
  fi
  # Root can bypass mode bits, so run the checker as an unprivileged account.
  chmod 755 "$TEST_ROOT" "$unreadable_root"
  unreadable_command=(
    runuser --user nobody -- bash "$CHECKER" "$unreadable_record"
    "$unreadable_json_path"
  )
else
  unreadable_command=(
    bash "$CHECKER" "$unreadable_record" "$unreadable_json_path"
  )
fi
if unreadable_output="$("${unreadable_command[@]}" 2>&1)"; then
  printf 'Unreadable Android preflight JSON unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$unreadable_output" "does not satisfy the redacted schema"
assert_not_contains "$unreadable_output" "$unreadable_json_sentinel"
assert_not_contains "$unreadable_output" "$unreadable_json_path"
assert_not_contains "$unreadable_output" "EACCES"

duplicate_json_sentinel="duplicate-preflight-secret"
cat >"$json_contract_path" <<EOF
{"schema":"android-preview-handoff-preflight/v1","schema":"$duplicate_json_sentinel","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","status":"FAIL","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical Android phone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if duplicate_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Android preflight JSON with duplicate fields unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$duplicate_json_output" "does not satisfy the redacted schema"
assert_not_contains "$duplicate_json_output" "$duplicate_json_sentinel"

unsafe_json_sentinel="https://preview-fixture.replit.dev/account=fixture-account/message=fixture-message"
cat >"$json_contract_path" <<EOF
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"$unsafe_json_sentinel"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"safe"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"safe"},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"safe"}}}
EOF
if unsafe_json_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Android preflight JSON with unsafe evidence unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$unsafe_json_output" "does not satisfy the redacted schema"
assert_not_contains "$unsafe_json_output" "$unsafe_json_sentinel"

cat >"$json_contract_path" <<'EOF'
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"FAIL","evidence":"Public manifest probe failed — no successful probe result was recorded"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical Android phone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if public_mismatch_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Android preflight JSON public-edge mismatch unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$public_mismatch_output" "public manifest boundary does not match"

cat >"$json_contract_path" <<'EOF'
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"FAIL","evidence":"Local manifest/bundle probe failed — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical Android phone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
if local_mismatch_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"; then
  printf 'Android preflight JSON local-probe mismatch unexpectedly passed.\n' >&2
  exit 1
fi
assert_contains "$local_mismatch_output" "local handoff boundary does not match"

cat >"$json_contract_path" <<'EOF'
{"schema":"android-preview-handoff-preflight/v1","platform":"android","boundaries":{"publicManifestReachability":{"status":"PASS","evidence":"public manifest HTTP 200 (128 bytes)"},"localHandoffProbe":{"status":"NOT_RUN","evidence":"Local manifest/bundle probe not run — no successful probe result was recorded"},"expoGoLaunch":{"status":"NOT_ASSESSED","evidence":"Requires a physical Android phone running stock Expo Go."},"serverNativeRequestEvidence":{"status":"NOT_ASSESSED","evidence":"Requires filtered Metro or API evidence from that physical Expo Go session."}}}
EOF
missing_phone_output="$(bash "$CHECKER" "$json_contract_record" 2>&1)"
assert_contains "$missing_phone_output" "validation passed"

# Default discovery must be exercised against an isolated repository layout:
# the workspace's artifact-level test-results/ tree is gitignored, so a clean
# checkout has no record there. The checker resolves its record root relative
# to its own location, so a copy inside the fixture tree discovers the fixture
# records and must pick the newest timestamped directory.
discovery_root="$TEST_ROOT/default-discovery"
discovery_android_root="$discovery_root/artifacts/chat-app/test-results/encrypted-room-recovery/android"
mkdir -p "$discovery_root/scripts" \
  "$discovery_root/artifacts/chat-app/scripts" \
  "$discovery_android_root/20260101T000000Z" \
  "$discovery_android_root/20260102T000000Z"
cp "$CHECKER" "$discovery_root/scripts/"
cp "$ROOT_DIR/scripts/find-duplicate-json-object-keys.mjs" \
  "$discovery_root/scripts/"
cp "$ROOT_DIR/artifacts/chat-app/scripts/validate-preview-startup.mjs" \
  "$discovery_root/artifacts/chat-app/scripts/"
write_record "$discovery_android_root/20260101T000000Z/validation-record.md" <<'EOF'
# Older Android preview validation record

**Result: PASS — physical Android preview handoff observed**
EOF
cp "$blocked_record" "$discovery_android_root/20260102T000000Z/validation-record.md"
cp "$blocked_preflight" "$discovery_android_root/20260102T000000Z/android-preview-preflight.json"
default_output="$(bash "$discovery_root/scripts/check-android-preview-evidence.sh" 2>&1)"
assert_contains "$default_output" "validation passed: $discovery_android_root/20260102T000000Z/validation-record.md"

# Repository handoff records are durable review evidence even though the
# artifact-level test-results directory is ignored by default. Keep every
# retained record on the current four-boundary and sidecar contract; a stale
# record must not be silently exempted because a newer record exists.
repository_android_root="$ROOT_DIR/artifacts/chat-app/test-results/encrypted-room-recovery/android"
repository_records=()
if [[ -d "$repository_android_root" ]]; then
  while IFS= read -r repository_record; do
    repository_records+=("$repository_record")
  done < <(find "$repository_android_root" \
    -mindepth 2 \
    -maxdepth 2 \
    -type f \
    -name validation-record.md \
    -print |
    sort)
  for repository_record in "${repository_records[@]}"; do
    if ! git -C "$ROOT_DIR" ls-files --error-unmatch -- "$repository_record" >/dev/null 2>&1; then
      printf 'Repository Android preview validation record is not tracked: %s\n' \
        "$repository_record" >&2
      exit 1
    fi
    repository_preflight="${repository_record%/validation-record.md}/android-preview-preflight.json"
    if [[ ! -f "$repository_preflight" ]]; then
      printf 'Repository Android preview validation record is missing its preflight sidecar: %s\n' \
        "$repository_preflight" >&2
      exit 1
    fi
    if ! repository_output="$(
      bash "$CHECKER" "$repository_record" "$repository_preflight" 2>&1
    )"; then
      printf 'Repository Android preview validation record failed the current checker: %s\n%s\n' \
        "$repository_record" "$repository_output" >&2
      exit 1
    fi
    assert_contains "$repository_output" "validation passed"
  done
fi

empty_discovery_root="$TEST_ROOT/empty-discovery"
mkdir -p "$empty_discovery_root/scripts" \
  "$empty_discovery_root/artifacts/chat-app/test-results/encrypted-room-recovery/android"
cp "$CHECKER" "$empty_discovery_root/scripts/"
if missing_default_output="$(bash "$empty_discovery_root/scripts/check-android-preview-evidence.sh" 2>&1)"; then
  printf 'Default discovery unexpectedly passed without any Android preview record.\n' >&2
  exit 1
fi
assert_contains "$missing_default_output" "No Android preview evidence record was found under"

for malformed_status in "" GARBAGE; do
  malformed_record="$TEST_ROOT/malformed-status-${malformed_status:-blank}.md"
  sed \
    -e "s#| Public manifest reachability | PASS |.*#| Public manifest reachability | ${malformed_status} | Public result. |#" \
    "$blocked_record" >"$malformed_record"
  if malformed_output="$(bash "$CHECKER" "$malformed_record" 2>&1)"; then
    printf 'Record with public manifest status %s unexpectedly passed.\n' \
      "${malformed_status:-blank}" >&2
    exit 1
  fi
  assert_contains "$malformed_output" "Public manifest reachability"
done

non_latest_root="$TEST_ROOT/non-latest-record"
non_latest_android_root="$non_latest_root/artifacts/chat-app/test-results/encrypted-room-recovery/android"
latest_blocked="$non_latest_android_root/20991231T000000Z/validation-record.md"
changed_non_latest="$non_latest_android_root/20260101T000000Z/validation-record.md"
mkdir -p "$(dirname "$latest_blocked")" "$(dirname "$changed_non_latest")"
write_record "$latest_blocked" <<'EOF'
# Latest valid Android preview validation record

**Result: BLOCKED — no physical Android handoff was available**

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | Public probe returned HTTP 200. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local probe was not run. |
| Expo Go launch on physical Android | **BLOCKED** | No physical phone was available. |
| Server-side native request evidence | **BLOCKED** | No native Android request was available. |
EOF
write_record "$changed_non_latest" <<'EOF'
# Baseline Android preview validation record

**Result: BLOCKED — no physical Android handoff was available**

| Boundary | Status | Evidence |
| --- | --- | --- |
| Public manifest reachability | PASS | Public probe returned HTTP 200. |
| Local handoff probe (manifest and bundle) | NOT_RUN | The local probe was not run. |
| Expo Go launch on physical Android | **BLOCKED** | No physical phone was available. |
| Server-side native request evidence | **BLOCKED** | No native Android request was available. |
EOF
git -C "$non_latest_root" init -q
git -C "$non_latest_root" config user.email test@example.invalid
git -C "$non_latest_root" config user.name "Android preview evidence test"
git -C "$non_latest_root" add .
git -C "$non_latest_root" commit -qm "baseline Android preview records"
write_record "$changed_non_latest" <<'EOF'
# Changed incomplete Android preview validation record

**Result: PASS — physical Android preview handoff observed**
EOF
changed_records="$(
  git -C "$non_latest_root" diff \
    --name-only \
    --diff-filter=ACDMRT \
    HEAD \
    -- \
    "artifacts/chat-app/test-results/encrypted-room-recovery/android/**/validation-record.md"
)"
assert_contains "$changed_records" "20260101T000000Z/validation-record.md"
assert_not_contains "$changed_records" "20991231T000000Z/validation-record.md"
if non_latest_output="$(bash "$CHECKER" "$non_latest_root/$(
  printf '%s\n' "$changed_records" | head -n 1
)" 2>&1)"; then
  printf 'An incomplete changed non-latest PASS record unexpectedly passed while a valid latest record existed.\n' >&2
  exit 1
fi
assert_contains "$non_latest_output" "PASS records must include a real Device model value."

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
| Public manifest reachability | PASS | Public manifest returned HTTP 200. |
| Local handoff probe (manifest and bundle) | PASS | Manifest and bundle returned HTTP 200. |
| Expo Go launch on physical Android | PASS | Landing screen rendered. |
| Server-side native request evidence | PASS | Native request evidence: platform=android; client=Expo Go; user-agent=[redacted] |
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
  magick \
    -size 1600x160 \
    -background white \
    -fill black \
    -font DejaVu-Sans \
    -pointsize 28 \
    -gravity West \
    "label:${text}" \
    -strip \
    "$output_path"
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
  if strings -a "$forbidden_screenshot" 2>/dev/null |
    grep -Fq -- "${forbidden_fixtures[$category]}"; then
    printf 'Forbidden %s fixture unexpectedly remained in image metadata; test would not prove pixel inspection.\n' \
      "$category" >&2
    exit 1
  fi
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
  -e 's#| Expo Go launch on physical Android | \*\*BLOCKED\*\* |.*#| Expo Go launch on physical Android | PASS | Landing screen rendered. |#' \
  -e 's#| Phone model, Android version, and Expo Go version captured | \*\*BLOCKED\*\* |.*#| Phone model, Android version, and Expo Go version captured | PASS | Metadata captured. |#' \
  -e 's#| Server-side native request evidence | \*\*BLOCKED\*\* |.*#| Server-side native request evidence | PASS | Native request observed. |#' \
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