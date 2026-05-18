#!/usr/bin/env bash
# EC2 / Amazon Linux 2023 variant.
# AL2023 ships Python 3.9 by default; the codebase uses `X | None` union
# syntax that requires Python 3.10+. This script selects python3.11 (or any
# 3.10+ interpreter present) and recreates the venv if it was built with an
# incompatible version.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/venvs/tradematangi"

# Find a Python 3.10+ interpreter
PYTHON=""
for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" > /dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3.10+ is required. Install it on AL2023 with:"
    echo "  sudo dnf install -y python3.11"
    exit 1
fi

PYTHON_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "Using $PYTHON (Python $PYTHON_VERSION)"

# Recreate venv if it was built with a different (incompatible) Python
if [ -d "$VENV" ]; then
    VENV_PYTHON=$("$VENV/bin/python" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    if [ "$VENV_PYTHON" != "$PYTHON_VERSION" ]; then
        echo "Venv is Python $VENV_PYTHON but need $PYTHON_VERSION — recreating..."
        rm -rf "$VENV"
    fi
fi

if [ ! -d "$VENV" ]; then
    echo "Creating virtual environment at $VENV..."
    "$PYTHON" -m venv "$VENV"
fi

echo "Installing dependencies..."
"$VENV/bin/pip" install -q -r "$REPO_ROOT/backend/requirements.txt"

echo "Starting backend on port 8700..."
cd "$REPO_ROOT/backend"
nohup "$VENV/bin/uvicorn" app.main:app \
  --host 0.0.0.0 \
  --port 8700 \
  --workers 1 \
  --loop uvloop \
  --log-level info \
  > "$REPO_ROOT/backend.log" 2>&1 &

echo "Backend started (PID $!). Log: $REPO_ROOT/backend.log"
