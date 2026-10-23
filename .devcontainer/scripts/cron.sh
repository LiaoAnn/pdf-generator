#!/usr/bin/env bash
set -euo pipefail

workspace_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$workspace_dir"
mkdir -p .wrangler

if [[ "${1:-}" == "--background" ]]; then
  # VS Code runs postStartCommand on a TTY, as its session leader. When this
  # shell exits, the kernel sends SIGHUP to the whole foreground group, which
  # still includes the child if it is slow to open the log on the bind mount
  # and has not reached nohup yet. Ignoring HUP before the fork closes that
  # race; setsid then takes the scheduler off the terminal for good.
  trap '' HUP
  setsid bash .devcontainer/scripts/cron.sh >> .wrangler/cron.log 2>&1 < /dev/null &
  exit 0
fi

echo "[dev-cron $(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting (pid $$)"

# The lock is released on exit, including when the container stops.
exec 9>.wrangler/cron.lock
if ! flock --nonblock 9; then
  echo '[dev-cron] Scheduler is already running for this workspace.'
  exit 0
fi

# postStartCommand may run before the first pnpm install.
echo '[dev-cron] Waiting for project dependencies...'
until node --input-type=module -e "await import('croner'); await import('jsonc-parser')" > /dev/null 2>&1; do
  sleep 5
done

exec node .devcontainer/scripts/cron.mjs
