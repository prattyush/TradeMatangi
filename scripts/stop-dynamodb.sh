#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "Stopping DynamoDB Local..."
docker compose down dynamodb-local
echo "DynamoDB Local stopped. Data volume preserved."
