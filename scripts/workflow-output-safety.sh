#!/usr/bin/env bash

# GitHub parses workflow commands from runner output. Summary files are not
# command streams, but keeping the same encoding at that boundary prevents a
# control-input sentinel from being copied into reviewer-visible output.

sanitize_workflow_stream() {
  LC_ALL=C tr '\000-\011\013-\037\177' ' ' |
    sed 's/::/\&#58;\&#58;/g'
}

sanitize_workflow_text() {
  printf '%s' "$1" | sanitize_workflow_stream
}

# Render arbitrary text as a fenced Markdown block. The fence is longer than
# any backtick run in the input, so reviewer-controlled diagnostics cannot
# escape the block and change the surrounding summary.
render_markdown_code_block() {
  local i line remainder run
  local longest_backtick_run=0
  local fence_length=3
  local fence=""
  local backtick_run='`+'
  local non_backtick='[^`]*'
  local -a lines=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    lines+=("$line")
    remainder="$line"
    while [[ "$remainder" =~ ^($non_backtick)($backtick_run)(.*)$ ]]; do
      run="${BASH_REMATCH[2]}"
      if ((${#run} > longest_backtick_run)); then
        longest_backtick_run="${#run}"
      fi
      remainder="${BASH_REMATCH[3]}"
    done
  done

  if ((longest_backtick_run + 1 > fence_length)); then
    fence_length=$((longest_backtick_run + 1))
  fi
  for ((i = 0; i < fence_length; i++)); do
    fence="${fence}\`"
  done
  printf '%s\n' "$fence"
  for line in "${lines[@]}"; do
    printf '%s\n' "$line"
  done
  printf '%s\n' "$fence"
}