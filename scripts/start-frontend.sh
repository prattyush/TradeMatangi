#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$REPO_ROOT/frontend"

cd "$FRONTEND"

if [ ! -d "node_modules" ]; then
  echo "Installing npm dependencies (no-bin-links for WSL compatibility)..."
  npm install --no-bin-links
fi

export VITE_DISABLE_HMR="true"

echo "Starting frontend on http://localhost:5173 ..."
node node_modules/vite/bin/vite.js --host
