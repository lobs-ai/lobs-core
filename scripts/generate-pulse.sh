#!/bin/bash
# generate-pulse.sh — Generate pulse.json for the public website
# Queries the lobs DB for sanitized aggregate data, writes to the GitHub Pages repo
# Designed to be run by cron every 15 minutes

set -euo pipefail

DB="$HOME/.lobs/lobs.db"
SITE_DIR="$HOME/lobs/lobs-ai.github.io"
OUT="$SITE_DIR/pulse.json"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB" >&2
  exit 1
fi

# Get system uptime from lobs-core process
LOBS_PID=$(pgrep -f "node.*lobs-core" 2>/dev/null | head -1 || true)
if [ -n "$LOBS_PID" ]; then
  # Get process start time, calculate uptime
  if [[ "$OSTYPE" == "darwin"* ]]; then
    PROC_START=$(ps -p "$LOBS_PID" -o lstart= 2>/dev/null || echo "")
    if [ -n "$PROC_START" ]; then
      START_EPOCH=$(date -j -f "%a %b %d %T %Y" "$PROC_START" +%s 2>/dev/null || echo "0")
      NOW_EPOCH=$(date +%s)
      UPTIME_SECONDS=$((NOW_EPOCH - START_EPOCH))
    else
      UPTIME_SECONDS=0
    fi
  else
    UPTIME_SECONDS=$(( $(date +%s) - $(stat -c %Y /proc/$LOBS_PID 2>/dev/null || echo $(date +%s)) ))
  fi
  SYSTEM_STATUS="online"
else
  UPTIME_SECONDS=0
  SYSTEM_STATUS="offline"
fi

# Format uptime
if [ "$UPTIME_SECONDS" -ge 86400 ]; then
  UPTIME_HUMAN="$((UPTIME_SECONDS / 86400))d $((UPTIME_SECONDS % 86400 / 3600))h"
elif [ "$UPTIME_SECONDS" -ge 3600 ]; then
  UPTIME_HUMAN="$((UPTIME_SECONDS / 3600))h $((UPTIME_SECONDS % 3600 / 60))m"
else
  UPTIME_HUMAN="$((UPTIME_SECONDS / 60))m"
fi

TODAY=$(date -u +"%Y-%m-%dT00:00:00.000Z")
THIRTY_DAYS_AGO=$(date -u -v-30d +"%Y-%m-%dT00:00:00.000Z" 2>/dev/null || date -u -d "30 days ago" +"%Y-%m-%dT00:00:00.000Z")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# === Task aggregates ===
TASKS_ACTIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='active';")
TASKS_COMPLETED_TODAY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='completed' AND updated_at >= '$TODAY';")
TASKS_COMPLETED_TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='completed';")
TASKS_TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks;")

# === Worker run aggregates (30d) ===
RUNS_30D=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS_AGO';")
SUCCEEDED_30D=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS_AGO' AND succeeded=1;")
FAILED_30D=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS_AGO' AND succeeded=0;")
ACTIVE_WORKERS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE ended_at IS NULL;")

if [ "$RUNS_30D" -gt 0 ]; then
  SUCCESS_RATE=$(( SUCCEEDED_30D * 100 / RUNS_30D ))
else
  SUCCESS_RATE=0
fi

# === Token aggregates (30d) ===
TOKENS_IN=$(sqlite3 "$DB" "SELECT COALESCE(SUM(input_tokens), 0) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS_AGO';")
TOKENS_OUT=$(sqlite3 "$DB" "SELECT COALESCE(SUM(output_tokens), 0) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS_AGO';")
TOKENS_TOTAL=$((TOKENS_IN + TOKENS_OUT))

# === Per-agent breakdown (30d) ===
AGENT_JSON=$(sqlite3 -json "$DB" "
  SELECT 
    COALESCE(agent_type, 'unknown') as agent,
    COUNT(*) as runs,
    CASE WHEN COUNT(*) > 0 
      THEN CAST(SUM(CASE WHEN succeeded=1 THEN 1 ELSE 0 END) * 100 / COUNT(*) AS INTEGER)
      ELSE 0 END as success_rate
  FROM worker_runs 
  WHERE started_at >= '$THIRTY_DAYS_AGO'
  GROUP BY agent_type 
  ORDER BY runs DESC;
" 2>/dev/null)
[ -z "$AGENT_JSON" ] && AGENT_JSON="[]"

# === Live workers ===
LIVE_JSON=$(sqlite3 -json "$DB" "
  SELECT 
    COALESCE(agent_type, 'unknown') as agent,
    CAST((strftime('%s','now') - strftime('%s', started_at)) AS INTEGER) as running_for_seconds,
    COALESCE(SUBSTR(model, 1, INSTR(model, '/') - 1), 'unknown') as provider
  FROM worker_runs 
  WHERE ended_at IS NULL;
" 2>/dev/null)
[ -z "$LIVE_JSON" ] && LIVE_JSON="[]"

# === Recent activity (last 20 runs, sanitized) ===
ACTIVITY_JSON=$(sqlite3 -json "$DB" "
  SELECT 
    CASE 
      WHEN succeeded=1 THEN 'completed'
      WHEN succeeded=0 THEN 'failed'
      ELSE 'running' 
    END as type,
    COALESCE(agent_type, 'unknown') as agent,
    COALESCE(SUBSTR(model, 1, INSTR(model, '/') - 1), 'unknown') as provider,
    COALESCE(ended_at, started_at, datetime('now')) as timestamp
  FROM worker_runs 
  WHERE started_at >= '$THIRTY_DAYS_AGO'
  ORDER BY started_at DESC 
  LIMIT 20;
" 2>/dev/null)
[ -z "$ACTIVITY_JSON" ] && ACTIVITY_JSON="[]"

# === Build JSON ===
cat > "$OUT" << ENDJSON
{
  "system": {
    "status": "$SYSTEM_STATUS",
    "uptime_seconds": $UPTIME_SECONDS,
    "uptime_human": "$UPTIME_HUMAN",
    "version": "8.0"
  },
  "tasks": {
    "active": $TASKS_ACTIVE,
    "completed_today": $TASKS_COMPLETED_TODAY,
    "total_completed": $TASKS_COMPLETED_TOTAL,
    "total": $TASKS_TOTAL
  },
  "workers": {
    "active": $ACTIVE_WORKERS,
    "runs_30d": $RUNS_30D,
    "succeeded_30d": $SUCCEEDED_30D,
    "failed_30d": $FAILED_30D,
    "success_rate_30d": $SUCCESS_RATE,
    "by_agent": $AGENT_JSON
  },
  "tokens_30d": {
    "input": $TOKENS_IN,
    "output": $TOKENS_OUT,
    "total": $TOKENS_TOTAL
  },
  "live_workers": $LIVE_JSON,
  "recent_activity": $ACTIVITY_JSON,
  "generated_at": "$NOW"
}
ENDJSON

echo "Generated $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

# === Git commit and push ===
cd "$SITE_DIR"
if git diff --quiet -- pulse.json 2>/dev/null; then
  echo "No changes to pulse.json, skipping commit"
else
  git add pulse.json
  git commit -m "pulse: update $(date -u +'%Y-%m-%d %H:%M UTC')" --no-verify
  git push origin main 2>/dev/null && echo "Pushed to GitHub Pages" || echo "Push failed (will retry next run)"
fi
