#!/bin/sh
set -eu

# Non-interactive SSH does not necessarily load ~/.bun/bin into PATH.
if [ -n "${BUN_EXECUTABLE:-}" ]; then
  deploy_bun=$BUN_EXECUTABLE
elif command -v bun >/dev/null 2>&1; then
  deploy_bun=bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  deploy_bun=$HOME/.bun/bin/bun
else
  echo 'Bun is required on the deployment host (PATH, ~/.bun/bin/bun or BUN_EXECUTABLE)' >&2
  exit 1
fi

exec "$deploy_bun" "$(dirname "$0")/deploy/deploy.ts" "$@"
