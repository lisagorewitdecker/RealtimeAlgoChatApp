#!/usr/bin/env bash
#
# Reviewed Android release-runner toolchain pins.
#
# Keep the runner archive version, its published digest, and the Android
# build-tools version together. The bootstrap and release preflight scripts
# source this file, while the operator procedure is checked against it.

ANDROID_RUNNER_VERSION="2.337.0"
ANDROID_RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
ANDROID_BUILD_TOOLS_VERSION="35.0.0"

readonly ANDROID_RUNNER_VERSION
readonly ANDROID_RUNNER_SHA256
readonly ANDROID_BUILD_TOOLS_VERSION
export ANDROID_RUNNER_VERSION ANDROID_RUNNER_SHA256 ANDROID_BUILD_TOOLS_VERSION