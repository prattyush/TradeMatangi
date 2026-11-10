#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for APP_DIR in frontend webapp; do
  cd "$REPO_ROOT/$APP_DIR"
  if [ ! -d node_modules ]; then npm ci --no-bin-links; fi
  node node_modules/typescript/bin/tsc --noEmit
  node node_modules/vite/bin/vite.js build
done
# The website build empties dist first, so this never overlays an older app build.
cp -R "$REPO_ROOT/webapp/dist" "$REPO_ROOT/frontend/dist/webapp"
echo "Combined website and webapp build: $REPO_ROOT/frontend/dist"
