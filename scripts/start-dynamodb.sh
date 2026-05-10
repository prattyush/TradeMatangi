#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

if docker ps --format '{{.Names}}' | grep -q '^tradematangi-dynamodb$'; then
    echo "DynamoDB Local is already running at http://localhost:8000"
    exit 0
fi

echo "Starting DynamoDB Local..."
docker compose up -d dynamodb-local

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
