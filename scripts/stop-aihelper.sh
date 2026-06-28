#!/usr/bin/env bash
# Stop the aihelper server (same pattern as stop-backend.sh)
set -e

PID=$(lsof -ti tcp:8701 2>/dev/null || true)
if [ -z "$PID" ]; then
  echo "No process found on port 8701."
else
  echo "Stopping aihelper (PID $PID)..."
  kill "$PID"
  echo "Done."
fi
