#!/usr/bin/env bash
# Shared WSL/Linux and EC2 installer. Stop the backend before migrating its venv.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PATH="$HOME/venvs/tradematangi"
if [[ $# -gt 0 ]]; then
    if [[ $# -ne 2 || "$1" != "--venv" ]]; then
        echo "Usage: bash scripts/install-backend-dependencies.sh [--venv /path/to/venv]" >&2
        exit 1
    fi
    VENV_PATH="$2"
fi
PYTHON_BIN="$VENV_PATH/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "ERROR: venv not found at $VENV_PATH. Create it with Python 3.10+ first." >&2
    exit 1
fi

# Both distributions write neo_api_client/. Uninstall BEFORE requirements;
# removing legacy files after installing the new SDK would corrupt it.
REPAIR_NAMESPACE=$("$PYTHON_BIN" - <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version
if sys.version_info < (3, 10) or sys.prefix == sys.base_prefix:
    raise SystemExit("ERROR: an existing Python 3.10+ virtual environment is required")
try:
    version("neo-api-client")
except PackageNotFoundError:
    print("no")
else:
    print("yes")
PY
)
if [[ "$REPAIR_NAMESPACE" == "yes" ]]; then
    echo "Removing legacy Kotak SDK and repairing the shared import namespace..."
    "$PYTHON_BIN" -m pip uninstall -y neo-api-client kotakneoapi
fi

echo "Installing backend dependencies (Kotak SDK 3.0.7)..."
"$PYTHON_BIN" -m pip install -r "$REPO_ROOT/backend/requirements.txt"
NEO_LOG_FILE_ENABLED=false "$PYTHON_BIN" - <<'PY'
from importlib.metadata import PackageNotFoundError, version
try:
    version("neo-api-client")
except PackageNotFoundError:
    pass
else:
    raise SystemExit("ERROR: legacy neo-api-client is still installed")
if version("kotakneoapi") != "3.0.7":
    raise SystemExit("ERROR: expected kotakneoapi==3.0.7")
from neo_api_client import NeoAPI
from neo_api_client.websocket.feed import SFeedWebSocket
from neo_api_client.websocket.orderfeed import OrderFeedWebSocket
print("Kotak SDK 3.0.7 imports verified")
PY
"$PYTHON_BIN" -m pip check
echo "Backend dependencies verified."
