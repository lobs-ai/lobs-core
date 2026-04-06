#!/bin/bash
# create-agent.sh — Create a new standalone lobs-core agent
#
# Creates the agent's data directory and adds it to docker-compose.
# Run generate-compose.sh afterward to rebuild the compose file,
# or it's done automatically here.
#
# Usage:
#   ./scripts/create-agent.sh <name> [port]
#
# Example:
#   ./scripts/create-agent.sh briggs 9431

set -euo pipefail

NAME="${1:-}"
PORT="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_BASE="$HOME/.lobs-agents"
ROOT="$AGENTS_BASE/$NAME"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <agent-name> [port]"
  echo "Example: $0 briggs 9431"
  exit 1
fi

if [ -d "$ROOT" ]; then
  echo "Agent '$NAME' already exists at $ROOT"
  echo "Delete it first if you want to recreate: rm -rf $ROOT"
  exit 1
fi

# Auto-assign port if not provided (9431, 9432, 9433, ...)
if [ -z "$PORT" ]; then
  EXISTING=$(find "$AGENTS_BASE" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  PORT=$((9431 + EXISTING))
  echo "Auto-assigned port: $PORT"
fi

echo "Creating agent '$NAME' at $ROOT..."

# Create directory structure
mkdir -p "$ROOT/config/secrets"
mkdir -p "$ROOT/agents/main/context/memory"
mkdir -p "$ROOT/data"
mkdir -p "$ROOT/media"

# Copy subagent personality files (programmer, researcher, writer, reviewer, architect)
# These are needed for spawning subagents within the agent
LOBS_AGENTS="$HOME/.lobs/agents"
for subagent in programmer researcher writer reviewer architect; do
  if [ -d "$LOBS_AGENTS/$subagent" ]; then
    mkdir -p "$ROOT/agents/$subagent"
    cp "$LOBS_AGENTS/$subagent/SOUL.md" "$ROOT/agents/$subagent/SOUL.md" 2>/dev/null || true
    cp "$LOBS_AGENTS/$subagent/AGENTS.md" "$ROOT/agents/$subagent/AGENTS.md" 2>/dev/null || true
  fi
done

# Discord config (template)
cat > "$ROOT/config/discord.json" << 'EOF'
{
  "enabled": true,
  "guildId": "",
  "channels": {},
  "ownerId": "",
  "dmAllowFrom": [],
  "botAllowFrom": [],
  "channelPolicies": {},
  "guildPolicies": {}
}
EOF

# Discord token placeholder
cat > "$ROOT/config/secrets/discord-token.json" << EOF
{
  "botToken": "REPLACE_WITH_$(echo "$NAME" | tr '[:lower:]' '[:upper:]')_BOT_TOKEN"
}
EOF

# Default model config
cat > "$ROOT/config/models.json" << 'EOF'
{
  "tiers": {
    "standard": "anthropic/claude-sonnet-4-20250514",
    "medium": "openrouter/minimax/minimax-m2.7",
    "small": "openrouter/anthropic/claude-3.5-haiku"
  }
}
EOF

# SOUL.md template
cat > "$ROOT/agents/main/SOUL.md" << EOF
# ${NAME^}

You are ${NAME^}, an AI agent powered by lobs-core.

## Personality
Describe your personality here.

## Voice
How you communicate.

## Work Style
How you approach tasks.
EOF

# MEMORY.md stub
cat > "$ROOT/agents/main/MEMORY.md" << 'EOF'
# MEMORY.md

## Context
Agent memory index. Updated as the agent learns.
EOF

# Store the port assignment
echo "$PORT" > "$ROOT/.port"

echo ""
echo "✅ Agent '$NAME' created at $ROOT (port $PORT)"
echo ""
echo "Next steps:"
echo "  1. Edit $ROOT/agents/main/SOUL.md"
echo "  2. Set Discord bot token in $ROOT/config/secrets/discord-token.json"
echo "  3. Set guild/channel IDs in $ROOT/config/discord.json"

# Auto-regenerate docker-compose
if [ -x "$SCRIPT_DIR/generate-compose.sh" ]; then
  echo ""
  echo "Regenerating docker-compose.agents.yml..."
  "$SCRIPT_DIR/generate-compose.sh"
fi
