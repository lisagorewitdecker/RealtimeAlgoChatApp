#!/usr/bin/env bash
#
# Verify that GitHub has an online runner able to accept the Android native
# release jobs. This runs on GitHub-hosted infrastructure, before any
# self-hosted Android job can be scheduled.

set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "$SCRIPT_DIR" == "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="."
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_DIR" && pwd)"
# shellcheck source=scripts/workflow-output-safety.sh
source "$SCRIPT_DIR/workflow-output-safety.sh"

required_labels=(self-hosted linux android smallest-simulator)
required_label_text="$(IFS=', '; echo "${required_labels[*]}")"
runner_details=()
online_ready_runners=()
failures=()

record_failure() {
  failures+=("$1")
}

has_label() {
  local labels="$1"
  local required="$2"
  [[ ",${labels}," == *",${required},"* ]]
}

write_report() {
  local status="$1"
  local repository="${GITHUB_REPOSITORY:-unknown/repository}"
  local server_url="${GITHUB_SERVER_URL:-https://github.com}"
  local revision="${GITHUB_SHA:-main}"
  local procedure_url="${server_url}/${repository}/blob/${revision}/artifacts/chat-app/docs/native-large-text-device-check.md#mobile-release-pipeline"

  {
    echo "## Android release runner health"
    echo
    echo "- Status: **${status}**"
    echo "- Required labels: \`${required_label_text}\`"
    echo "- Operator procedure: [Native large-text release gate](${procedure_url})"
    if ((${#online_ready_runners[@]})); then
      echo "- Online runner with all required labels: ${online_ready_runners[*]}"
    fi
    if ((${#runner_details[@]})); then
      echo
      echo "### Runner inventory"
      for detail in "${runner_details[@]}"; do
        printf -- '- %s\n' "$(sanitize_workflow_text "$detail")"
      done
    fi
    if ((${#failures[@]})); then
      echo
      echo "### Blocking findings"
      for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$(sanitize_workflow_text "$failure")"
      done
    fi
  } | tee /dev/stderr

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## Android release runner health"
      echo
      echo "- Status: **${status}**"
      echo "- Required labels: \`${required_label_text}\`"
      echo "- Operator procedure: [Native large-text release gate](${procedure_url})"
      if ((${#online_ready_runners[@]})); then
        echo "- Online runner with all required labels: ${online_ready_runners[*]}"
      fi
      if ((${#runner_details[@]})); then
        echo
        echo "### Runner inventory"
        for detail in "${runner_details[@]}"; do
          printf -- '- %s\n' "$(sanitize_workflow_text "$detail")"
        done
      fi
      if ((${#failures[@]})); then
        echo
        echo "### Blocking findings"
        for failure in "${failures[@]}"; do
          printf -- '- %s\n' "$(sanitize_workflow_text "$failure")"
        done
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if ! command -v gh >/dev/null 2>&1; then
  record_failure "The GitHub CLI is required to inspect repository self-hosted runners."
elif ! command -v jq >/dev/null 2>&1; then
  record_failure "jq is required to inspect the GitHub runner inventory."
elif [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  record_failure "GITHUB_REPOSITORY is required to inspect the repository runner inventory."
elif [[ -z "${GH_TOKEN:-}" ]]; then
  record_failure "GITHUB_WORKFLOW_PULL_TOKEN_FINAL must be configured with Administration: read access."
else
  runner_json="$(
    gh api --paginate --slurp \
      "repos/${GITHUB_REPOSITORY}/actions/runners?per_page=100" \
      2>/dev/null
  )"
  api_status=$?
  if ((api_status != 0)); then
    record_failure "Could not query the repository self-hosted runner inventory."
  elif ! jq -e 'type == "array" and all(.[]; (.runners? | type == "array"))' \
    >/dev/null 2>&1 <<<"$runner_json"; then
    record_failure "The repository self-hosted runner inventory response was invalid."
  else
    while IFS=$'\t' read -r runner_name runner_status runner_labels; do
      [[ -n "$runner_name" ]] || continue
      missing_labels=()
      for required_label in "${required_labels[@]}"; do
        if ! has_label "$runner_labels" "$required_label"; then
          missing_labels+=("$required_label")
        fi
      done

      if [[ "$runner_status" == "online" && "${#missing_labels[@]}" -eq 0 ]]; then
        safe_runner_name="$(sanitize_workflow_text "$runner_name")"
        online_ready_runners+=("\`${safe_runner_name}\`")
        runner_details+=("\`${safe_runner_name}\`: online; all required labels present")
      elif ((${#missing_labels[@]})); then
        missing_label_text="$(IFS=', '; echo "${missing_labels[*]}")"
        safe_runner_name="$(sanitize_workflow_text "$runner_name")"
        runner_details+=("\`${safe_runner_name}\`: ${runner_status}; missing labels: ${missing_label_text}")
      else
        safe_runner_name="$(sanitize_workflow_text "$runner_name")"
        runner_details+=("\`${safe_runner_name}\`: ${runner_status}; required labels present but runner is not online")
      fi
    done < <(
      jq -r '
        .[]?.runners[]? |
        [
          (.name // "unnamed-runner"),
          (.status // "unknown"),
          ([.labels[]?.name] | join(","))
        ] | @tsv
      ' <<<"$runner_json"
    )

    if ((${#online_ready_runners[@]} == 0)); then
      record_failure "No online repository runner has all required labels: ${required_label_text}."
    fi
  fi
fi

if ((${#failures[@]})); then
  echo "ANDROID_RELEASE_RUNNER_HEALTH=BLOCKED" >&2
  write_report "BLOCKED"
  exit 2
fi

echo "ANDROID_RELEASE_RUNNER_HEALTH=READY"
write_report "READY"