#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "Usage: pnpm --filter @workspace/chat-app test:native-sentry ios|android" >&2
  exit 2
fi

for value in \
  NATIVE_SMOKE_APP_ID \
  NATIVE_SMOKE_BUILD_ID \
  NATIVE_SMOKE_RESULTS_DIR \
  NATIVE_SENTRY_MARKER; do
  if [[ -z "${!value:-}" ]]; then
    echo "Required native Sentry verification configuration is incomplete." >&2
    exit 2
  fi
done

if [[ ! "$NATIVE_SENTRY_MARKER" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
  echo "NATIVE_SENTRY_MARKER must contain only letters, digits, underscores, and hyphens." >&2
  exit 2
fi

: "${NATIVE_SMOKE_SCHEME:=chat-app}"
export NATIVE_SMOKE_APP_ID NATIVE_SMOKE_BUILD_ID NATIVE_SMOKE_SCHEME
export NATIVE_SENTRY_MARKER

mkdir -p "$NATIVE_SMOKE_RESULTS_DIR"
maestro_device_args=()
if [[ "$PLATFORM" == "ios" && -n "${NATIVE_SMOKE_IOS_DEVICE_UDID:-}" ]]; then
  maestro_device_args=(--device "$NATIVE_SMOKE_IOS_DEVICE_UDID")
fi
maestro "${maestro_device_args[@]}" test \
  --format JUNIT \
  --output "$NATIVE_SMOKE_RESULTS_DIR/sentry-maestro-results.xml" \
  "$(dirname "${BASH_SOURCE[0]}")/flow.yaml"

cat > "$NATIVE_SMOKE_RESULTS_DIR/sentry-trigger.txt" <<EOF
platform=$PLATFORM
candidate_build_id=$NATIVE_SMOKE_BUILD_ID
marker=$NATIVE_SENTRY_MARKER
EOF

echo "Controlled native Sentry error submitted for $PLATFORM."#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "Usage: pnpm --filter @workspace/chat-app test:native-sentry ios|android" >&2
  exit 2
fi

for value in \
  NATIVE_SMOKE_APP_ID \
  NATIVE_SMOKE_BUILD_ID \
  NATIVE_SMOKE_RESULTS_DIR \
  NATIVE_SENTRY_MARKER; do
  if [[ -z "${!value:-}" ]]; then
    echo "Required native Sentry verification configuration is incomplete." >&2
    exit 2
  fi
done

if [[ ! "$NATIVE_SENTRY_MARKER" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
  echo "NATIVE_SENTRY_MARKER must contain only letters, digits, underscores, and hyphens." >&2
  exit 2
fi

: "${NATIVE_SMOKE_SCHEME:=chat-app}"
export NATIVE_SMOKE_APP_ID NATIVE_SMOKE_BUILD_ID NATIVE_SMOKE_SCHEME
export NATIVE_SENTRY_MARKER

mkdir -p "$NATIVE_SMOKE_RESULTS_DIR"
maestro_device_args=()
if [[ "$PLATFORM" == "ios" && -n "${NATIVE_SMOKE_IOS_DEVICE_UDID:-}" ]]; then
  maestro_device_args=(--device "$NATIVE_SMOKE_IOS_DEVICE_UDID")
fi
maestro "${maestro_device_args[@]}" test \
  --format JUNIT \
  --output "$NATIVE_SMOKE_RESULTS_DIR/sentry-maestro-results.xml" \
  "$(dirname "${BASH_SOURCE[0]}")/flow.yaml"

cat > "$NATIVE_SMOKE_RESULTS_DIR/sentry-trigger.txt" <<EOF
platform=$PLATFORM
candidate_build_id=$NATIVE_SMOKE_BUILD_ID
marker=$NATIVE_SENTRY_MARKER
EOF

echo "Controlled native Sentry error submitted for $PLATFORM."