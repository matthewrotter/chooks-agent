#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/nanoclaw/chooks-agent/nanoclaw.pid)

set -euo pipefail

cd "/home/nanoclaw/chooks-agent"

# Stop existing instance if running
if [ -f "/home/nanoclaw/chooks-agent/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/nanoclaw/chooks-agent/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

# Load environment variables
if [ -f "/home/nanoclaw/chooks-agent/.env" ]; then
  set -a
  source "/home/nanoclaw/chooks-agent/.env"
  set +a
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/home/nanoclaw/chooks-agent/dist/index.js" \
  >> "/home/nanoclaw/chooks-agent/logs/nanoclaw.log" \
  2>> "/home/nanoclaw/chooks-agent/logs/nanoclaw.error.log" &

echo $! > "/home/nanoclaw/chooks-agent/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/nanoclaw/chooks-agent/logs/nanoclaw.log"
