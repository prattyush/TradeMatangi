#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$REPO_ROOT/frontend"

PID_FILE="$REPO_ROOT/.cache/frontend/preview.pid"
if [ -f "$PID_FILE" ]; then
  read -r FRONTEND_PID < "$PID_FILE"
  if [[ "$FRONTEND_PID" =~ ^[0-9]+$ ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "Frontend PID $FRONTEND_PID is already running. Stop it before starting again."
    exit 1
  fi
fi
bash "$REPO_ROOT/scripts/build-frontend-with-webapp.sh"
mkdir -p "$REPO_ROOT/.cache/frontend"
echo $$ > "$PID_FILE"
cd "$FRONTEND"
echo "Website: http://localhost:5173/ · Webapp: http://localhost:5173/webapp/"
exec node "$FRONTEND/node_modules/vite/bin/vite.js" preview --host 127.0.0.1 --port 5173 --strictPort
