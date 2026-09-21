#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 COMMAND [ARG...]" >&2
  exit 2
fi

# Keep checker output visible for reviewers, but prevent any untrusted output
# from being interpreted as a GitHub workflow command or annotation.
stop_token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
echo "::stop-commands::${stop_token}"
set +e
"$@"
checker_status=$?
set -e
echo "::${stop_token}::"
exit "$checker_status"#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 COMMAND [ARG...]" >&2
  exit 2
fi

# Keep checker output visible for reviewers, but prevent any untrusted output
# from being interpreted as a GitHub workflow command or annotation.
stop_token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
echo "::stop-commands::${stop_token}"
set +e
"$@"
checker_status=$?
set -e
echo "::${stop_token}::"
exit "$checker_status"#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 COMMAND [ARG...]" >&2
  exit 2
fi

# Keep checker output visible for reviewers, but prevent any untrusted output
# from being interpreted as a GitHub workflow command or annotation.
stop_token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
echo "::stop-commands::${stop_token}"
set +e
"$@"
checker_status=$?
set -e
echo "::${stop_token}::"
exit "$checker_status"#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: $0 COMMAND [ARG...]" >&2
  exit 2
fi

# Keep checker output visible for reviewers, but prevent any untrusted output
# from being interpreted as a GitHub workflow command or annotation.
stop_token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
echo "::stop-commands::${stop_token}"
set +e
"$@"
checker_status=$?
set -e
echo "::${stop_token}::"
exit "$checker_status"