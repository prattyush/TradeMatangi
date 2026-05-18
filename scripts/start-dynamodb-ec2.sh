#!/usr/bin/env bash
# EC2 / Amazon Linux 2023 variant.
# AL2023 ships Docker Engine without the Compose plugin. This script detects
# whichever compose command is present and falls back with install instructions.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Detect compose command
if docker compose version > /dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo "ERROR: No Docker Compose found. Install it on AL2023 with:"
    echo "  sudo dnf install -y docker-compose-plugin"
    echo "Then re-run this script."
    exit 1
fi

if docker ps --format '{{.Names}}' | grep -q '^tradematangi-dynamodb$'; then
    echo "DynamoDB Local is already running at http://localhost:8000"
    exit 0
fi

echo "Starting DynamoDB Local (using: $COMPOSE)..."
$COMPOSE up -d dynamodb-local

# Wait until the endpoint responds
echo -n "Waiting for DynamoDB Local to be ready"
for i in $(seq 1 20); do
    if curl -s http://localhost:8000 > /dev/null 2>&1; then
        echo ""
        echo "DynamoDB Local is ready at http://localhost:8000"
        exit 0
    fi
    echo -n "."
    sleep 1
done

echo ""
echo "WARNING: DynamoDB Local did not respond within 20 seconds. Check: docker logs tradematangi-dynamodb"
exit 1
