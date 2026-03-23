#!/usr/bin/env bash
# check-task-metadata.sh — Validate active task metadata completeness.
#
# Flags tasks that are missing critical fields:
#   - shape (tier classification: tier-1, high, standard, etc.)
#   - priority
#   - notes (empty description)
#
# Exit 1 if any issues found (suitable for CI or pre-push hooks).
# Run manually: ./scripts/check-task-metadata.sh
# Run with --warn-only to report but not fail: ./scripts/check-task-metadata.sh --warn-only

set -euo pipefail

DB="${LOBS_DB:-$HOME/.lobs/lobs.db}"
WARN_ONLY=0
if [[ "${1:-}" == "--warn-only" ]]; then
  WARN_ONLY=1
fi

if [[ ! -f "$DB" ]]; then
  echo "⚠️  Database not found at $DB — skipping task metadata check"
  exit 0
fi

ISSUES=0

echo "🔍 Checking active task metadata in $DB..."

# Check for missing shape (tier) on active tasks
MISSING_SHAPE=$(sqlite3 "$DB" \
  "SELECT id, substr(title,1,60) FROM tasks WHERE status='active' AND (shape IS NULL OR shape='');" 2>/dev/null)
if [[ -n "$MISSING_SHAPE" ]]; then
  echo ""
  echo "❌ Active tasks missing 'shape' (tier classification):"
  echo "$MISSING_SHAPE" | while IFS='|' read -r id title; do
    echo "   • ${id:0:8}  $title"
  done
  ISSUES=$((ISSUES + 1))
fi

# Check for missing priority on active tasks
MISSING_PRIORITY=$(sqlite3 "$DB" \
  "SELECT id, substr(title,1,60) FROM tasks WHERE status='active' AND (priority IS NULL OR priority='');" 2>/dev/null)
if [[ -n "$MISSING_PRIORITY" ]]; then
  echo ""
  echo "❌ Active tasks missing 'priority':"
  echo "$MISSING_PRIORITY" | while IFS='|' read -r id title; do
    echo "   • ${id:0:8}  $title"
  done
  ISSUES=$((ISSUES + 1))
fi

# Check for suspiciously short notes (< 20 chars) on active tasks
TRUNCATED_NOTES=$(sqlite3 "$DB" \
  "SELECT id, substr(title,1,60), length(notes) FROM tasks WHERE status='active' AND (notes IS NULL OR length(notes) < 20);" 2>/dev/null)
if [[ -n "$TRUNCATED_NOTES" ]]; then
  echo ""
  echo "⚠️  Active tasks with empty or very short notes (possible truncation):"
  echo "$TRUNCATED_NOTES" | while IFS='|' read -r id title notelen; do
    echo "   • ${id:0:8}  $title  [notes: ${notelen:-0} chars]"
  done
  # Don't fail for this — some tasks legitimately have short notes
fi

# Summary
echo ""
if [[ $ISSUES -eq 0 ]]; then
  echo "✅ All active tasks have complete metadata (shape + priority)"
  exit 0
else
  echo "Found $ISSUES metadata issue(s) in active tasks."
  echo "Fix: set shape='tier-1|high|standard' and priority='high|medium|low' for each task."
  echo "     sqlite3 ~/.lobs/lobs.db \"UPDATE tasks SET shape='tier-1', priority='high' WHERE id='<id>';\""
  echo "     or: paw-task update <id> --shape tier-1 --priority high"
  if [[ $WARN_ONLY -eq 1 ]]; then
    echo "⚠️  (warn-only mode — not failing)"
    exit 0
  fi
  exit 1
fi
