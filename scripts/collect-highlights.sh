#!/usr/bin/env bash
# collect-highlights.sh — Scan repos and DB for noteworthy changes since last run
# Writes structured highlights to a rolling file the Presence Sync agent reads.
# Designed as a daily script cron job.
set -euo pipefail

DB="$HOME/.lobs/lobs.db"
HIGHLIGHTS_DIR="$HOME/lobs-shared-memory"
HIGHLIGHTS_FILE="$HIGHLIGHTS_DIR/highlights.md"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TODAY=$(date +"%Y-%m-%d")

# How far back to scan (default: 3 days for Mon/Thu coverage)
SINCE=$(date -v-3d +"%Y-%m-%d" 2>/dev/null || date -d "3 days ago" +"%Y-%m-%d")

echo "Collecting highlights since $SINCE..."

# ── Initialize/rotate highlights file ──
# Keep last 30 days of highlights, drop older
if [ -f "$HIGHLIGHTS_FILE" ]; then
  CUTOFF=$(date -v-30d +"%Y-%m-%d" 2>/dev/null || date -d "30 days ago" +"%Y-%m-%d")
  # Keep entries newer than cutoff (entries start with ## date headers)
  awk -v cutoff="$CUTOFF" '/^## [0-9]{4}-[0-9]{2}-[0-9]{2}/ { date=$2; printing=(date >= cutoff) } printing || !/^## [0-9]{4}-[0-9]{2}-[0-9]{2}/' "$HIGHLIGHTS_FILE" > "${HIGHLIGHTS_FILE}.tmp" 2>/dev/null || cp "$HIGHLIGHTS_FILE" "${HIGHLIGHTS_FILE}.tmp"
  mv "${HIGHLIGHTS_FILE}.tmp" "$HIGHLIGHTS_FILE"
else
  echo "# Highlights — Auto-collected for Public Presence Sync" > "$HIGHLIGHTS_FILE"
  echo "" >> "$HIGHLIGHTS_FILE"
fi

# Start today's section
{
  echo ""
  echo "## $TODAY (auto-collected $NOW)"
  echo ""
} >> "$HIGHLIGHTS_FILE"

# ── 1. Git commits across key repos ──
REPOS=(
  "$HOME/lobs/lobs-core:lobs-core"
  "$HOME/lobs/lobs-nexus:lobs-nexus"
  "$HOME/lobs/lobs-memory:lobs-memory"
  "$HOME/lobs/lobs-mobile:lobs-mobile"
  "$HOME/lobs/lobs-vim:lobs-vim"
  "$HOME/lobs/lobs-sentinel:lobs-sentinel"
  "$HOME/lobs/lobs-mcp:lobs-mcp"
  "$HOME/lobs/lobs-ai.github.io:website"
)

COMMIT_COUNT=0
{
  echo "### Git Activity"
  echo ""
  for entry in "${REPOS[@]}"; do
    REPO_PATH="${entry%%:*}"
    REPO_NAME="${entry##*:}"
    if [ -d "$REPO_PATH/.git" ]; then
      COMMITS=$(cd "$REPO_PATH" && git log --since="$SINCE" --oneline --no-merges 2>/dev/null || true)
      if [ -n "$COMMITS" ]; then
        COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
        COMMIT_COUNT=$((COMMIT_COUNT + COUNT))
        echo "**$REPO_NAME** ($COUNT commits):"
        # Show feat/fix commits first, then others (max 8 per repo)
        echo "$COMMITS" | grep -iE "^[a-f0-9]+ (feat|fix|add|implement|build|refactor)" | head -5 | sed 's/^/- /' || true
        echo "$COMMITS" | grep -viE "^[a-f0-9]+ (feat|fix|add|implement|build|refactor)" | head -3 | sed 's/^/- /' || true
        echo ""
      fi
    fi
  done
  if [ "$COMMIT_COUNT" -eq 0 ]; then
    echo "_No commits in the last 3 days._"
    echo ""
  fi
} >> "$HIGHLIGHTS_FILE"

# ── 2. New/completed tasks ──
{
  echo "### Tasks"
  echo ""
  COMPLETED=$(sqlite3 "$DB" "SELECT title FROM tasks WHERE status='completed' AND updated_at >= '$SINCE' ORDER BY updated_at DESC LIMIT 10" 2>/dev/null || true)
  if [ -n "$COMPLETED" ]; then
    echo "**Completed:**"
    echo "$COMPLETED" | sed 's/^/- ✅ /'
    echo ""
  fi
  ACTIVE=$(sqlite3 "$DB" "SELECT title FROM tasks WHERE status='active' ORDER BY priority DESC LIMIT 5" 2>/dev/null || true)
  if [ -n "$ACTIVE" ]; then
    echo "**Active:**"
    echo "$ACTIVE" | sed 's/^/- 🔧 /'
    echo ""
  fi
  if [ -z "$COMPLETED" ] && [ -z "$ACTIVE" ]; then
    echo "_No task changes._"
    echo ""
  fi
} >> "$HIGHLIGHTS_FILE"

# ── 3. Worker stats summary ──
{
  echo "### Worker Activity"
  echo ""
  STATS=$(sqlite3 "$DB" "
    SELECT COALESCE(agent_type, 'unknown') as agent, COUNT(*) as runs,
      SUM(CASE WHEN succeeded=1 THEN 1 ELSE 0 END) as ok,
      SUM(CASE WHEN succeeded=0 THEN 1 ELSE 0 END) as fail
    FROM worker_runs WHERE started_at >= '$SINCE'
    GROUP BY agent_type ORDER BY runs DESC" 2>/dev/null || true)
  if [ -n "$STATS" ]; then
    echo "| Agent | Runs | OK | Failed |"
    echo "|-------|------|----|--------|"
    echo "$STATS" | while IFS='|' read -r agent runs ok fail; do
      echo "| $agent | $runs | $ok | $fail |"
    done
    echo ""
  else
    echo "_No worker runs._"
    echo ""
  fi
} >> "$HIGHLIGHTS_FILE"

# ── 4. New repos (check GitHub) ──
{
  NEW_REPOS=$(gh api orgs/lobs-ai/repos --paginate --jq ".[] | select(.created_at >= \"${SINCE}T00:00:00Z\") | .name + \": \" + (.description // \"no description\")" 2>/dev/null || true)
  if [ -n "$NEW_REPOS" ]; then
    echo "### New Repositories"
    echo ""
    echo "$NEW_REPOS" | sed 's/^/- 🆕 /'
    echo ""
  fi
} >> "$HIGHLIGHTS_FILE"

# ── 5. Manual highlights (appended by agents during work) ──
# These are tagged with <!-- manual --> and preserved across runs
# Agents write them via: echo "- **thing**: description <!-- manual -->" >> highlights.md

TOTAL_LINES=$(wc -l < "$HIGHLIGHTS_FILE" | tr -d ' ')
echo "Highlights collected: $COMMIT_COUNT commits across repos, written to $HIGHLIGHTS_FILE ($TOTAL_LINES lines)"
