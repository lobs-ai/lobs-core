#!/usr/bin/env bash
# update-pulse.sh — Fetch live metrics from lobs-core and push to lobslab.com
# Runs as a cron script job (no LLM needed).
set -euo pipefail

SITE_DIR="$HOME/lobs/lobs-ai.github.io"
API_URL="http://localhost:9420/api/public/pulse"
DB_PATH="$HOME/.lobs/lobs.db"

cd "$SITE_DIR"

# Pull latest
git pull --rebase origin main --quiet

# Fetch live metrics (fallback to DB query if API is down)
if PULSE=$(curl -sf --max-time 10 "$API_URL"); then
  echo "$PULSE" | jq '.' > pulse.json
  echo "Fetched live pulse from API"
else
  echo "API unreachable, building pulse from DB"
  
  # Build pulse from direct DB queries
  ACTIVE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='active'")
  COMPLETED_TODAY=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed' AND created_at >= date('now', 'start of day')")
  TOTAL_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed'")
  TOTAL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks")
  RUNS_30D=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= datetime('now', '-30 days')")
  SUCCEEDED_30D=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= datetime('now', '-30 days') AND succeeded=1")
  FAILED_30D=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= datetime('now', '-30 days') AND succeeded=0")
  
  if [ "$RUNS_30D" -gt 0 ]; then
    SUCCESS_RATE=$(( SUCCEEDED_30D * 100 / RUNS_30D ))
  else
    SUCCESS_RATE=0
  fi

  cat > pulse.json << EOJSON
{
  "system": {
    "status": "offline",
    "uptime_seconds": 0,
    "uptime_human": "0m",
    "version": "8.0"
  },
  "tasks": {
    "active": $ACTIVE,
    "completed_today": $COMPLETED_TODAY,
    "total_completed": $TOTAL_COMPLETED,
    "total": $TOTAL
  },
  "workers": {
    "active": 0,
    "runs_30d": $RUNS_30D,
    "succeeded_30d": $SUCCEEDED_30D,
    "failed_30d": $FAILED_30D,
    "success_rate_30d": $SUCCESS_RATE
  },
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOJSON
fi

# Validate JSON
jq . pulse.json > /dev/null

# Check if anything meaningful changed (ignore generated_at timestamp)
DIFF=$(git diff pulse.json | grep '^[+-]' | grep -v '^[+-][+-][+-]' | grep -v 'generated_at' | grep -v 'uptime' || true)
if [ -z "$DIFF" ]; then
  # Only timestamp/uptime changed — not worth a commit
  git checkout -- pulse.json
  echo "Only timestamp changed, skipping commit"
  exit 0
fi

# Commit and push
git add pulse.json
git commit -m "chore: update pulse metrics [$(date +%Y-%m-%d)]" --quiet
git push origin main --quiet

echo "Pulse update pushed successfully"
