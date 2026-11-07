#!/usr/bin/env bash
# Fails if preprod has commits that dev does not contain, i.e. a real-trading fix
# that has not been synced into dev yet. Run after merging anything into preprod
# and before merging dev into preprod.
#
# Fix: branch off origin/dev, `git merge origin/preprod`, PR into dev, and merge
# that PR with "Create a merge commit" (never squash/rebase).
set -euo pipefail

git fetch -q origin dev preprod

missing=$(git log --oneline origin/dev..origin/preprod)
if [ -n "$missing" ]; then
  echo "preprod has commits that dev does not contain:"
  echo "$missing"
  echo
  echo "Sync them: git checkout -b sync/preprod-into-dev origin/dev && git merge origin/preprod"
  exit 1
fi
echo "OK: dev contains everything on preprod."

if git merge-tree --write-tree origin/preprod origin/dev >/dev/null 2>&1; then
  echo "OK: merging dev into preprod has no conflicts."
else
  echo "WARNING: merging dev into preprod would conflict:"
  git merge-tree --write-tree --name-only --no-messages origin/preprod origin/dev | tail -n +2 || true
  exit 2
fi
