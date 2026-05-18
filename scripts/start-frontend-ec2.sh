#!/usr/bin/env bash
# EC2 / Amazon Linux 2023 variant.
# The browser blocks requests from a public IP to localhost (Private Network
# Access policy). This script resolves the EC2 public IP and passes it as
# VITE_API_BASE_URL so the browser calls http://<ec2-ip>:8700 instead of
# http://localhost:8700. Falls back to BACKEND_IP env var if metadata is
# unreachable (useful for custom domains or private subnets).
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$REPO_ROOT/frontend"

# Resolve backend IP: env override → IMDSv2 → IMDSv1 → fail
if [ -n "$BACKEND_IP" ]; then
    PUBLIC_IP="$BACKEND_IP"
    echo "Using BACKEND_IP override: $PUBLIC_IP"
else
    echo "Detecting EC2 public IP via instance metadata..."
    TOKEN=$(curl -sf --connect-timeout 2 -X PUT \
        "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)

    if [ -n "$TOKEN" ]; then
        PUBLIC_IP=$(curl -sf --connect-timeout 2 \
            -H "X-aws-ec2-metadata-token: $TOKEN" \
            http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
    else
        # IMDSv1 fallback
        PUBLIC_IP=$(curl -sf --connect-timeout 2 \
            http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
    fi

    if [ -z "$PUBLIC_IP" ]; then
        echo "ERROR: Could not detect public IP. Set BACKEND_IP manually:"
        echo "  BACKEND_IP=<your-ip> ./scripts/start-frontend-ec2.sh"
        exit 1
    fi
    echo "Detected public IP: $PUBLIC_IP"
fi

export VITE_API_BASE_URL="http://$PUBLIC_IP:8700"
echo "Backend URL: $VITE_API_BASE_URL"

cd "$FRONTEND"

if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Resolve LOG_DIR from accesskeys.ini — mirrors config.py logic
INI="$REPO_ROOT/data/accesskeys.ini"
LOG_DIR=$(awk -F'=' '/^\[paths\]/{f=1;next} /^\[/{f=0} f&&/^logs[[:space:]]*/{gsub(/^[[:space:]]+|[[:space:]]+$/,"",$2); print $2; exit}' "$INI" 2>/dev/null || true)
if [ -z "$LOG_DIR" ]; then
    LOG_DIR="$REPO_ROOT/data/logs"
fi
mkdir -p "$LOG_DIR"

# Write to a date-stamped file (matches backend's rotation pattern: frontend.log.YYYY-MM-DD).
# Update the frontend.log symlink so `tail -f frontend.log` always follows today's file.
DATED_LOG="$LOG_DIR/frontend.log.$(date +%Y-%m-%d)"
ln -sf "$DATED_LOG" "$LOG_DIR/frontend.log"

echo "Starting frontend on http://$PUBLIC_IP:5173 ..."
nohup node node_modules/vite/bin/vite.js --host \
  >> "$DATED_LOG" 2>&1 &

echo "Frontend started (PID $!). Log: $DATED_LOG"
