#!/usr/bin/env bash
# =============================================================================
# GSI Office Hours Bot — Course Setup Script
# =============================================================================
#
# Usage:
#   ./setup-course.sh --course eecs281 --guild <DISCORD_GUILD_ID> \
#                     --ta <TA_DISCORD_USER_ID> [--materials /path/to/pdfs/]
#
# This script:
#   1. Creates ~/.lobs/gsi/<courseId>.json with your Discord server config
#   2. Ingests course materials (PDFs, syllabi, notes) into lobs-memory
#   3. Ingests the built-in EECS 281 FAQ seed data
#   4. Registers the /ask slash command with your Discord server
#
# Prerequisites:
#   - lobs-core running (lobs start)
#   - lobs-memory running on port 7420
#   - Discord bot token configured in lobs config
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOBS_CORE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GSI_CONFIG_DIR="$HOME/.lobs/gsi"

# ── Argument parsing ──────────────────────────────────────────────────────────

COURSE_ID=""
COURSE_NAME=""
GUILD_ID=""
TA_IDS=()
MATERIALS_DIR=""
LOG_CHANNEL=""
CONFIDENCE_THRESHOLD="0.65"

print_usage() {
  echo "Usage: $0 --course <courseId> --guild <guildId> --ta <userId> [options]"
  echo ""
  echo "Required:"
  echo "  --course <id>          Course ID, e.g. eecs281"
  echo "  --guild <id>           Discord guild (server) ID"
  echo "  --ta <userId>          Discord user ID to escalate to (repeat for multiple TAs)"
  echo ""
  echo "Optional:"
  echo "  --name <display name>  Course display name (default: uppercase of course ID)"
  echo "  --materials <dir>      Directory of PDFs/markdown/txt to ingest"
  echo "  --log-channel <id>     Discord channel ID to log all Q&A"
  echo "  --threshold <0-1>      Confidence threshold for escalation (default: 0.65)"
  echo ""
  echo "Examples:"
  echo "  $0 --course eecs281 --guild 123456789 --ta 987654321"
  echo "  $0 --course eecs281 --guild 123456789 --ta 111 --ta 222 --materials ~/syllabi/eecs281/"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --course)   COURSE_ID="$2"; shift 2 ;;
    --name)     COURSE_NAME="$2"; shift 2 ;;
    --guild)    GUILD_ID="$2"; shift 2 ;;
    --ta)       TA_IDS+=("$2"); shift 2 ;;
    --materials) MATERIALS_DIR="$2"; shift 2 ;;
    --log-channel) LOG_CHANNEL="$2"; shift 2 ;;
    --threshold) CONFIDENCE_THRESHOLD="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *)          echo "Unknown argument: $1"; print_usage; exit 1 ;;
  esac
done

# ── Validation ────────────────────────────────────────────────────────────────

if [[ -z "$COURSE_ID" || -z "$GUILD_ID" ]]; then
  echo "Error: --course and --guild are required."
  echo ""
  print_usage
  exit 1
fi

if [[ ${#TA_IDS[@]} -eq 0 ]]; then
  echo "Warning: No --ta specified. Escalations will be logged but no one will be DMed."
fi

# Default course name
if [[ -z "$COURSE_NAME" ]]; then
  COURSE_NAME="${COURSE_ID^^}: Course Assistant"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│           GSI Office Hours Bot — Course Setup           │"
echo "└─────────────────────────────────────────────────────────┘"
echo ""
echo "  Course ID:    $COURSE_ID"
echo "  Course Name:  $COURSE_NAME"
echo "  Guild ID:     $GUILD_ID"
echo "  TAs:          ${TA_IDS[*]:-none}"
echo "  Materials:    ${MATERIALS_DIR:-none}"
echo "  Log Channel:  ${LOG_CHANNEL:-none}"
echo "  Threshold:    $CONFIDENCE_THRESHOLD"
echo ""

# ── Step 1: Write course config ───────────────────────────────────────────────

echo "▶ Step 1: Writing course config..."
mkdir -p "$GSI_CONFIG_DIR"

TA_IDS_JSON=$(printf '%s\n' "${TA_IDS[@]}" | jq -R . | jq -s .)

jq -n \
  --arg courseId "$COURSE_ID" \
  --arg courseName "$COURSE_NAME" \
  --arg guildId "$GUILD_ID" \
  --argjson escalationUserIds "$TA_IDS_JSON" \
  --argjson confidenceThreshold "$CONFIDENCE_THRESHOLD" \
  --arg logChannelId "${LOG_CHANNEL:-}" \
  '{
    courseId: $courseId,
    courseName: $courseName,
    guildId: $guildId,
    channelIds: [],
    escalationUserIds: $escalationUserIds,
    memoryCollections: ["\($courseId)-course"],
    confidenceThreshold: $confidenceThreshold,
    dmEscalations: false,
    logChannelId: (if $logChannelId == "" then null else $logChannelId end),
    enabled: true
  }' > "$GSI_CONFIG_DIR/$COURSE_ID.json"

echo "  ✓ Config written to $GSI_CONFIG_DIR/$COURSE_ID.json"

# ── Step 2: Ingest seed FAQ ───────────────────────────────────────────────────

echo ""
echo "▶ Step 2: Ingesting seed FAQ..."
SEED_FILE="$SCRIPT_DIR/seed-data/${COURSE_ID}-faq.json"
if [[ -f "$SEED_FILE" ]]; then
  node --input-type=module <<EOF
import { ingestFile } from '${LOBS_CORE_DIR}/dist/gsi/gsi-ingest.js';
const result = await ingestFile('${SEED_FILE}', {
  courseId: '${COURSE_ID}',
  label: '${COURSE_ID^^} FAQ — Seed Data',
  tags: ['${COURSE_ID}', 'faq', 'seed'],
});
console.log(result.success
  ? \`  ✓ Seed FAQ ingested: \${result.chunkCount} chunks\`
  : \`  ✗ Seed FAQ failed: \${result.error}\`
);
EOF
else
  echo "  ℹ No seed FAQ found at $SEED_FILE — skipping"
fi

# ── Step 3: Ingest course materials ──────────────────────────────────────────

if [[ -n "$MATERIALS_DIR" ]]; then
  echo ""
  echo "▶ Step 3: Ingesting course materials from $MATERIALS_DIR..."
  node --input-type=module <<EOF
import { ingestCourseDirectory } from '${LOBS_CORE_DIR}/dist/gsi/gsi-ingest.js';
const results = await ingestCourseDirectory('${MATERIALS_DIR}', {
  courseId: '${COURSE_ID}',
  tags: ['${COURSE_ID}', 'course-material'],
});
const ok = results.filter(r => r.success).length;
const chunks = results.reduce((s, r) => s + (r.chunkCount ?? 0), 0);
console.log(\`  ✓ Ingested \${ok}/\${results.length} files (\${chunks} total chunks)\`);
EOF
else
  echo ""
  echo "▶ Step 3: No materials directory specified — skipping"
  echo "  (Add course materials later: node dist/gsi/gsi-ingest.js --course $COURSE_ID --dir /path/to/materials/)"
fi

# ── Step 4: Register slash command ───────────────────────────────────────────

echo ""
echo "▶ Step 4: Slash commands are registered automatically when lobs-core starts."
echo "  If you've just added this config, restart lobs-core to pick it up:"
echo "  → lobs restart"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│                       ✓ Setup Complete                  │"
echo "└─────────────────────────────────────────────────────────┘"
echo ""
echo "  Next steps:"
echo "  1. Invite the bot to your Discord server (if not already)"
echo "  2. Run: lobs restart  (to register /ask slash command)"
echo "  3. In Discord: /ask question:What is the difference between BFS and DFS?"
echo ""
echo "  Config file: $GSI_CONFIG_DIR/$COURSE_ID.json"
echo "  To add more materials: node $LOBS_CORE_DIR/dist/gsi/gsi-ingest.js \\"
echo "    --course $COURSE_ID --dir /path/to/your/materials/"
echo ""
