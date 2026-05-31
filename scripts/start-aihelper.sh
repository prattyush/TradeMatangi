#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/venvs/tradematangi"

if [ ! -d "$VENV" ]; then
  echo "Creating Python virtual environment at $VENV..."
  python3 -m venv "$VENV"
fi

echo "Installing aihelper dependencies..."
"$VENV/bin/pip" install -q -r "$REPO_ROOT/aihelper/requirements.txt"

LOG_FILE="$REPO_ROOT/data/logs/aihelper.log"
echo "Starting aihelper on http://0.0.0.0:8701 ..."
echo "Logs: $LOG_FILE  (tail -f to follow)"
cd "$REPO_ROOT/aihelper"
"$VENV/bin/uvicorn" main:app --host 0.0.0.0 --port 8701 --reload
