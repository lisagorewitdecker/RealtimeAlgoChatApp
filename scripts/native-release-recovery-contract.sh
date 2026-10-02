#!/usr/bin/env bash

# Keep these reviewer-facing recovery lines in one place. They are sourced by
# the evidence checker and by workflow contract checks; do not interpolate
# runtime evidence or download metadata into them.
NATIVE_IOS_RECOVERY_LINE="- Recovery: **Rerun the iOS native large-text job, or make the existing iOS artifact available, then rerun the mobile release gate.**"
NATIVE_ANDROID_RECOVERY_LINE="- Recovery: **Rerun the Android native large-text job, or make the existing Android artifact available, then rerun the mobile release gate.**"

native_release_recovery_line() {
  case "$1" in
    ios)
      printf '%s\n' "$NATIVE_IOS_RECOVERY_LINE"
      ;;
    android)
      printf '%s\n' "$NATIVE_ANDROID_RECOVERY_LINE"
      ;;
    *)
      return 1
      ;;
  esac
}