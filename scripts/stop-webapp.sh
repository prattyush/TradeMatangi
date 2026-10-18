#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/.cache/webapp/dev.pid"
if [ ! -f "$PID_FILE" ]; then echo "Webapp is not running."; exit 0; fi
read -r WEBAPP_PID < "$PID_FILE"
if [[ ! "$WEBAPP_PID" =~ ^[0-9]+$ ]]; then echo "Invalid webapp PID file."; exit 1; fi
if kill -0 "$WEBAPP_PID" 2>/dev/null; then
  WEBAPP_COMMAND="$(tr '\0' ' ' < "/proc/$WEBAPP_PID/cmdline")"
  if [[ "$WEBAPP_COMMAND" != *"$REPO_ROOT/webapp/node_modules/vite/bin/vite.js"* ]]; then
    echo "PID belongs to another process; leaving it running."; exit 1
  fi
  kill "$WEBAPP_PID"
  echo "Webapp stopped."
else
  echo "Webapp is not running."
fi
rm -f "$PID_FILE"
