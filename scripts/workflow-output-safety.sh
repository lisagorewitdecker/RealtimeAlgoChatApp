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