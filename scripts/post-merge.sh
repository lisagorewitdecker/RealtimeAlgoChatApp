#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm run typecheck
