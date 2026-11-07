#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/webapp"
PID_FILE="$REPO_ROOT/.cache/webapp/dev.pid"
if [ -f "$PID_FILE" ]; then
  read -r WEBAPP_PID < "$PID_FILE"
  if [[ "$WEBAPP_PID" =~ ^[0-9]+$ ]] && kill -0 "$WEBAPP_PID" 2>/dev/null; then
    echo "Webapp PID $WEBAPP_PID is already running. Stop it before starting again."
    exit 1
  fi
fi
if [ ! -d node_modules ]; then npm ci --no-bin-links; fi
mkdir -p "$REPO_ROOT/.cache/webapp"
echo $$ > "$PID_FILE"
echo "Starting webapp at http://localhost:5174/webapp/"
exec node "$REPO_ROOT/webapp/node_modules/vite/bin/vite.js" --host 127.0.0.1
