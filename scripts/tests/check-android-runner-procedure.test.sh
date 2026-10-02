#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROCEDURE="$WORKSPACE_ROOT/artifacts/chat-app/docs/native-large-text-device-check.md"

assert_contains() {
  local text="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" <<<"$text"; then
    printf 'Expected Android runner procedure to contain: %s\n' "$expected" >&2
    exit 1
  fi
}

procedure="$(cat "$PROCEDURE")"
bootstrap_block="$(
  sed -n \
    '/^Then provision the Android SDK/,/^The final readiness check below/p' \
    "$PROCEDURE"
)"

if grep -Fq -- "--start-emulator" <<<"$bootstrap_block"; then
  echo "The SDK bootstrap must not launch an unmanaged emulator." >&2
  exit 1
fi

if grep -Fq -- "sudo ./svc.sh start" <<<"$procedure"; then
  echo "The runner must start through systemd after emulator readiness." >&2
  exit 1
fi

assert_contains "$procedure" \
  "ExecStartPost=/usr/bin/timeout 120 /usr/local/sbin/wait-for-android-native-emulator"
assert_contains "$procedure" "Requires=android-native-emulator.service"
assert_contains "$procedure" "After=android-native-emulator.service"
assert_contains "$procedure" \
  'sudo systemctl is-active --quiet android-native-emulator.service'
assert_contains "$procedure" \
  "emulator_processes=\"\$(pgrep -fc '[a]ndroid-sdk/emulator/emulator @native-small-api35')\""

emulator_start_line="$(
  grep -nF -- 'sudo systemctl enable --now android-native-emulator.service' \
    "$PROCEDURE" | head -n 1 | cut -d: -f1
)"
runner_start_line="$(
  grep -nF -- 'sudo systemctl enable --now "$RUNNER_SERVICE"' \
    "$PROCEDURE" | head -n 1 | cut -d: -f1
)"
if [[ -z "$emulator_start_line" || -z "$runner_start_line" || "$emulator_start_line" -ge "$runner_start_line" ]]; then
  echo "The procedure must start the emulator service before the runner service." >&2
  exit 1
fi

echo "Android runner provisioning procedure regression test passed."