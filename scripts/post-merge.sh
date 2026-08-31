#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db exec tsc -p tsconfig.json
pnpm --filter @workspace/db run push-force
