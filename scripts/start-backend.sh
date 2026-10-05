#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/venvs/tradematangi"

if [ ! -d "$VENV" ]; then
  echo "Creating Python virtual environment at $VENV..."
  python3 -m venv "$VENV"
fi

echo "Installing dependencies..."
bash "$REPO_ROOT/scripts/install-backend-dependencies.sh" --venv "$VENV"
# Script dependencies (options_indicator.py and other standalone scripts)
"$VENV/bin/pip" install -q mplfinance matplotlib

LOG_FILE="$REPO_ROOT/data/logs/backend.log"
echo "Starting backend on http://0.0.0.0:8700 ..."
echo "Logs: $LOG_FILE  (tail -f to follow)"
cd "$REPO_ROOT/backend"
"$VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port 8700 --reload
