#!/usr/bin/env bash
# ============================================================
# install-staged-check-cron.sh
# Installs (or updates) the weekly staged-changes cron job.
#
# Usage:
#   ./install-staged-check-cron.sh          # install/update
#   ./install-staged-check-cron.sh --remove # remove the cron entry
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-staged-changes.sh"
LOG_FILE="$HOME/.lobs/logs/staged-check.log"
CRON_TAG="# lobs-staged-check"

# Runs every Friday at 17:00 local time
CRON_SCHEDULE="0 17 * * 5"
CRON_LINE="$CRON_SCHEDULE $CHECK_SCRIPT >> $LOG_FILE 2>&1 $CRON_TAG"

# Ensure script is executable
chmod +x "$CHECK_SCRIPT"

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")"

if [[ "${1:-}" == "--remove" ]]; then
  echo "Removing lobs-staged-check cron entry..."
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
  echo "Done. Cron entry removed."
  exit 0
fi

# Check if already installed
if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
  echo "Updating existing lobs-staged-check cron entry..."
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | { cat; echo "$CRON_LINE"; } | crontab -
else
  echo "Installing lobs-staged-check cron entry..."
  { crontab -l 2>/dev/null; echo "$CRON_LINE"; } | crontab -
fi

echo ""
echo "✓ Cron installed:"
echo "  Schedule : Every Friday at 17:00"
echo "  Script   : $CHECK_SCRIPT"
echo "  Log      : $LOG_FILE"
echo ""
echo "Current crontab (lobs entries):"
crontab -l 2>/dev/null | grep "lobs" || echo "  (none visible)"
echo ""
echo "To test immediately:"
echo "  $CHECK_SCRIPT --dry-run"
echo ""
echo "To remove:"
echo "  $SCRIPT_DIR/install-staged-check-cron.sh --remove"
