#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/.cache/frontend/preview.pid"
if [ ! -f "$PID_FILE" ]; then echo "Frontend is not running (no managed PID)."; exit 0; fi
read -r FRONTEND_PID < "$PID_FILE"
if [[ ! "$FRONTEND_PID" =~ ^[0-9]+$ ]]; then echo "Invalid frontend PID file."; exit 1; fi
if kill -0 "$FRONTEND_PID" 2>/dev/null; then
  FRONTEND_COMMAND="$(tr '\0' ' ' < "/proc/$FRONTEND_PID/cmdline")"
  if [[ "$FRONTEND_COMMAND" != *"$REPO_ROOT/frontend/node_modules/vite/bin/vite.js preview"* ]]; then
    echo "PID belongs to another process; leaving it running."; exit 1
  fi
  kill "$FRONTEND_PID"
  echo "Frontend stopped."
else
  echo "Frontend is not running."
fi
rm -f "$PID_FILE"
