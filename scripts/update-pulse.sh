#!/usr/bin/env bash
# update-pulse.sh — Generate pulse.json from DB and push to lobslab.com
# Runs as a cron script job. Queries DB directly for rich metrics.
set -euo pipefail

DB="$HOME/.lobs/lobs.db"
SITE_DIR="$HOME/lobs/lobs-ai.github.io"
OUT="$SITE_DIR/pulse.json"

[ ! -f "$DB" ] && echo "ERROR: DB not found at $DB" >&2 && exit 1

cd "$SITE_DIR"
git pull --rebase origin main --quiet 2>/dev/null || true

# ── System uptime ──
LOBS_PID=$(pgrep -f "node.*lobs-core" 2>/dev/null | head -1 || true)
if [ -n "$LOBS_PID" ]; then
  SYSTEM_STATUS="online"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    PROC_START=$(ps -p "$LOBS_PID" -o lstart= 2>/dev/null || echo "")
    if [ -n "$PROC_START" ]; then
      START_EPOCH=$(date -j -f "%a %b %d %T %Y" "$PROC_START" +%s 2>/dev/null || echo "0")
      UPTIME_SECONDS=$(( $(date +%s) - START_EPOCH ))
    else
      UPTIME_SECONDS=0
    fi
  else
    UPTIME_SECONDS=$(( $(date +%s) - $(stat -c %Y /proc/$LOBS_PID 2>/dev/null || echo $(date +%s)) ))
  fi
else
  SYSTEM_STATUS="offline"
  UPTIME_SECONDS=0
fi

# Format uptime
if [ "$UPTIME_SECONDS" -ge 86400 ]; then
  UPTIME_HUMAN="$((UPTIME_SECONDS / 86400))d $((UPTIME_SECONDS % 86400 / 3600))h"
elif [ "$UPTIME_SECONDS" -ge 3600 ]; then
  UPTIME_HUMAN="$((UPTIME_SECONDS / 3600))h $((UPTIME_SECONDS % 3600 / 60))m"
else
  UPTIME_HUMAN="$((UPTIME_SECONDS / 60))m"
fi

# ── Time ranges ──
TODAY=$(date -u +"%Y-%m-%dT00:00:00.000Z")
THIRTY_DAYS=$(date -u -v-30d +"%Y-%m-%dT00:00:00.000Z" 2>/dev/null || date -u -d "30 days ago" +"%Y-%m-%dT00:00:00.000Z")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# ── Task metrics ──
TASKS_ACTIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='active'")
TASKS_TODAY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='completed' AND updated_at >= '$TODAY'")
TASKS_COMPLETED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='completed'")
TASKS_TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks")

# ── Worker metrics (30d) ──
RUNS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS'")
SUCCEEDED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS' AND succeeded=1")
FAILED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS' AND succeeded=0")
ACTIVE_WORKERS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM worker_runs WHERE ended_at IS NULL")
[ "$RUNS" -gt 0 ] && SUCCESS_RATE=$(( SUCCEEDED * 100 / RUNS )) || SUCCESS_RATE=0

# ── Token metrics (30d) ──
TOKENS_IN=$(sqlite3 "$DB" "SELECT COALESCE(SUM(input_tokens), 0) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS'")
TOKENS_OUT=$(sqlite3 "$DB" "SELECT COALESCE(SUM(output_tokens), 0) FROM worker_runs WHERE started_at >= '$THIRTY_DAYS'")

# ── Live workers (currently running) ──
LIVE_WORKERS_JSON=$(sqlite3 -json "$DB" "
  SELECT COALESCE(agent_type, 'unknown') as agent,
    COALESCE(SUBSTR(model, 1, INSTR(model, '/') - 1), 'unknown') as provider,
    CAST((strftime('%s','now') - strftime('%s', started_at)) AS INTEGER) as running_for_seconds
  FROM worker_runs WHERE ended_at IS NULL
  ORDER BY started_at ASC" 2>/dev/null || echo "[]")
[ -z "$LIVE_WORKERS_JSON" ] && LIVE_WORKERS_JSON="[]"

# ── Per-agent breakdown ──
AGENT_JSON=$(sqlite3 -json "$DB" "
  SELECT COALESCE(agent_type, 'unknown') as agent, COUNT(*) as runs,
    CAST(SUM(CASE WHEN succeeded=1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS INTEGER) as success_rate
  FROM worker_runs WHERE started_at >= '$THIRTY_DAYS'
  GROUP BY agent_type ORDER BY runs DESC" 2>/dev/null || echo "[]")
[ -z "$AGENT_JSON" ] && AGENT_JSON="[]"

# ── Recent activity (last 20 runs) ──
ACTIVITY_JSON=$(sqlite3 -json "$DB" "
  SELECT CASE WHEN succeeded=1 THEN 'completed' WHEN succeeded=0 THEN 'failed' ELSE 'running' END as type,
    COALESCE(agent_type, 'unknown') as agent,
    COALESCE(SUBSTR(model, 1, INSTR(model, '/') - 1), 'unknown') as provider,
    COALESCE(ended_at, started_at, datetime('now')) as timestamp
  FROM worker_runs WHERE started_at >= '$THIRTY_DAYS'
  ORDER BY started_at DESC LIMIT 20" 2>/dev/null || echo "[]")
[ -z "$ACTIVITY_JSON" ] && ACTIVITY_JSON="[]"

# ── Build JSON ──
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
    "completed_today": $TASKS_TODAY,
    "total_completed": $TASKS_COMPLETED,
    "total": $TASKS_TOTAL
  },
  "workers": {
    "active": $ACTIVE_WORKERS,
    "runs_30d": $RUNS,
    "succeeded_30d": $SUCCEEDED,
    "failed_30d": $FAILED,
    "success_rate_30d": $SUCCESS_RATE,
    "by_agent": $AGENT_JSON
  },
  "tokens_30d": {
    "input": $TOKENS_IN,
    "output": $TOKENS_OUT,
    "total": $((TOKENS_IN + TOKENS_OUT))
  },
  "live_workers": $LIVE_WORKERS_JSON,
  "recent_activity": $ACTIVITY_JSON,
  "generated_at": "$NOW"
}
ENDJSON

# Validate
jq . "$OUT" > /dev/null

# ── Smart diff: skip if only timestamp/uptime changed ──
DIFF=$(git diff "$OUT" | grep '^[+-]' | grep -v '^[+-][+-][+-]' | grep -v 'generated_at' | grep -v 'uptime' || true)
if [ -z "$DIFF" ]; then
  git checkout -- "$OUT" 2>/dev/null || true
  echo "Pulse: no meaningful changes"
  exit 0
fi

git add "$OUT"
git commit -m "pulse: update $(date -u +'%Y-%m-%d %H:%M UTC')" --quiet --no-verify
git push origin main --quiet 2>/dev/null && echo "Pulse updated and pushed" || echo "Push failed (will retry)"
