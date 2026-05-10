#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/venvs/tradematangi"

if [ ! -d "$VENV" ]; then
  echo "Creating Python virtual environment at $VENV..."
  python3 -m venv "$VENV"
fi

echo "Installing dependencies..."
"$VENV/bin/pip" install -q -r "$REPO_ROOT/backend/requirements.txt"

echo "Starting backend on http://0.0.0.0:8700 ..."
cd "$REPO_ROOT/backend"
"$VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port 8700 --reload
