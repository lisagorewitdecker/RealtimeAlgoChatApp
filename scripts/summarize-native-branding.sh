#!/usr/bin/env bash
# Appends one platform's native branding section to the GitHub job summary.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/workflow-output-safety.sh"

PLATFORM="${1:?Usage: summarize-native-branding.sh <ios|android>}"
report_error() {
  echo "$*" >&2
}

case "$PLATFORM" in
  ios)
    PLATFORM_LABEL="iOS"
    PERMISSION_LABEL="Permission copy"
    ;;
  android)
    PLATFORM_LABEL="Android"
    PERMISSION_LABEL="Permission declarations"
    ;;
  *)
    report_error "Unsupported platform: ${PLATFORM} (expected ios or android)"
    exit 2
    ;;
esac

RESULTS_DIR="${NATIVE_SMOKE_RESULTS_DIR:?Set NATIVE_SMOKE_RESULTS_DIR to the platform result directory.}"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY to the job summary file.}"
ARTIFACT_NAME="native-large-text-${PLATFORM}"
ARTIFACT_URL="${NATIVE_BRANDING_ARTIFACT_URL:-}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}"
REPORT_URL="${ARTIFACT_URL:-$RUN_URL}"
SUMMARY_SOURCE="$RESULTS_DIR/native-branding-summary.md"

candidate_fingerprint() {
  local build_id="$1"
  local digest=""
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$build_id" | sha256sum | cut -c1-12)"
  elif command -v shasum >/dev/null 2>&1; then
    digest="$(printf '%s' "$build_id" | shasum -a 256 | cut -c1-12)"
  elif command -v openssl >/dev/null 2>&1; then
    digest="$(printf '%s' "$build_id" | openssl dgst -sha256 | sed 's/^.*= *//' | cut -c1-12)"
  fi
  if [[ "$digest" =~ ^[0-9a-f]{12}$ ]]; then
    printf '%s' "$digest"
  else
    printf '%s' "unavailable"
  fi
}

if [[ -n "${NATIVE_SMOKE_BUILD_ID:-}" ]]; then
  safe_build_id="$(sanitize_workflow_text "$NATIVE_SMOKE_BUILD_ID")"
  FALLBACK_BUILD_LINE="- Candidate build ID: \`${safe_build_id}\` (fingerprint \`$(candidate_fingerprint "$NATIVE_SMOKE_BUILD_ID")\`)"
else
  FALLBACK_BUILD_LINE="- Candidate build ID: \`Unavailable\`"
fi

SAFE_REPORT_URL="$(sanitize_workflow_text "$REPORT_URL")"
sed_replacement="${SAFE_REPORT_URL//\\/\\\\}"
sed_replacement="${sed_replacement//&/\\&}"
sed_replacement="${sed_replacement//|/\\|}"

render_summary_source() {
  sed "s|__NATIVE_BRANDING_REPORT_URL__|${sed_replacement}|g" "$SUMMARY_SOURCE" |
    sanitize_workflow_stream
}

render_branding_source_literal() {
  render_summary_source |
    sed -e '1d' -e '/^- Detailed report:/d' |
    render_markdown_code_block
}

write_archived_snapshot() {
  echo "- Archived report snapshot: [available in this summary](#archived-native-branding-report-snapshot)"
  echo
  echo "### Archived native branding report snapshot"
  echo

  if [[ -s "$SUMMARY_SOURCE" ]]; then
    # Keep the fixed snapshot link outside the copied report. The report
    # content itself is literal so it cannot restyle the durable summary.
    echo "- Detailed report: preserved in this release summary; the artifact copy is linked above while retained."
    render_branding_source_literal
  else
    echo "- Status: **FAIL**"
    echo "$FALLBACK_BUILD_LINE"
    echo "- Native label: \`Unavailable\`"
    echo "- ${PERMISSION_LABEL}: **UNAVAILABLE** (native metadata was not inspected)"
    echo "- Detailed report: preserved in this release summary; the artifact copy was not generated."
  fi
  echo
}

write_summary() {
  {
    if [[ -s "$SUMMARY_SOURCE" ]]; then
      echo "## ${PLATFORM_LABEL} native branding"
      echo
      echo "- Detailed report: [native-branding-check.md](${SAFE_REPORT_URL})"
      echo
      echo "### Branding validation details"
      render_branding_source_literal
    else
      echo "## ${PLATFORM_LABEL} native branding"
      echo
      echo "- Status: **FAIL**"
      echo "$FALLBACK_BUILD_LINE"
      echo "- Native label: \`Unavailable\`"
      echo "- ${PERMISSION_LABEL}: **UNAVAILABLE** (native metadata was not inspected)"
      echo "- Detailed report: \`native-branding-check.md\` was not generated; open the [${ARTIFACT_NAME} output](${SAFE_REPORT_URL}) to find the failing step"
      echo
    fi

    write_archived_snapshot

    if [[ -z "$ARTIFACT_URL" ]]; then
      echo "The \`${ARTIFACT_NAME}\` artifact was not uploaded, so the report link above opens the workflow run instead of the artifact download."
      echo
    fi
  } >> "$SUMMARY_FILE"
}

write_summary
echo "Appended the ${PLATFORM_LABEL} native branding section to ${SUMMARY_FILE}"