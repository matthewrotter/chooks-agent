#!/bin/bash
# NanoClaw watchdog — checks heartbeat file, restarts if stale, cleans orphaned containers.
# Runs via launchd every 5 minutes.

HEARTBEAT_FILE="/Users/skip.rotter/dev/experimental/chooks-agent/data/heartbeat"
LOG_FILE="/Users/skip.rotter/dev/experimental/chooks-agent/logs/watchdog.log"
MAX_STALE_SECONDS=300  # 5 minutes without heartbeat = stale

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; }

# Clean up orphaned containers regardless of NanoClaw state
cleanup_containers() {
  local now=$(date +%s)
  local max_age_seconds=3900  # 65 minutes (CONTAINER_TIMEOUT + IDLE_TIMEOUT + grace)

  for name in $(container ls --format json 2>/dev/null | \
    /usr/bin/python3 -c "
import sys, json
for c in json.load(sys.stdin):
    n = c['configuration']['id']
    if c['status'] == 'running' and n.startswith('nanoclaw-'):
        print(n)
" 2>/dev/null); do
    # Extract epoch from container name
    epoch_ms=$(echo "$name" | grep -oE '[0-9]{13}$')
    if [ -z "$epoch_ms" ]; then continue; fi

    epoch_s=$((epoch_ms / 1000))
    age=$((now - epoch_s))

    if [ "$age" -gt "$max_age_seconds" ]; then
      log "Stopping stale container $name (age: ${age}s)"
      container stop "$name" 2>/dev/null
    fi
  done
}

# Always run container cleanup
cleanup_containers

# Check heartbeat
if [ ! -f "$HEARTBEAT_FILE" ]; then
  log "No heartbeat file found — NanoClaw may not be running, launchd should handle restart"
  exit 0
fi

last_beat=$(cat "$HEARTBEAT_FILE" 2>/dev/null)
if [ -z "$last_beat" ]; then
  log "Heartbeat file empty"
  exit 0
fi

now_ms=$(($(date +%s) * 1000))
age_ms=$((now_ms - last_beat))
age_s=$((age_ms / 1000))

if [ "$age_s" -gt "$MAX_STALE_SECONDS" ]; then
  log "STALE heartbeat (${age_s}s old) — killing NanoClaw process"

  # Find and kill the NanoClaw node process
  pkill -f "node.*dist/index.js" 2>/dev/null

  # launchd KeepAlive will restart it automatically
  # The startup cleanup in ensureContainerSystemRunning() will handle orphaned containers
  log "NanoClaw killed — launchd will restart it"
fi
