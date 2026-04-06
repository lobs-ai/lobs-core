#!/bin/bash
# create-agent.sh — Create a new agent and register it in agents.json
#
# Usage:
#   ./scripts/create-agent.sh <name> <type> [port]
#
# Types:
#   standalone  — Full lobs-core instance with Docker container + Discord bot
#   subagent    — Personality profile loaded by standalone agents (no Docker)
#
# Examples:
#   ./scripts/create-agent.sh briggs standalone 9431
#   ./scripts/create-agent.sh coder subagent

set -euo pipefail

NAME="${1:-}"
TYPE="${2:-}"
PORT="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.lobs/agents.json"
AGENTS_BASE="$HOME/.lobs-agents"

if [ -z "$NAME" ] || [ -z "$TYPE" ]; then
  echo "Usage: $0 <name> <type> [port]"
  echo "  type: standalone | subagent"
  echo ""
  echo "Examples:"
  echo "  $0 briggs standalone 9431"
  echo "  $0 coder subagent"
  exit 1
fi

if [ "$TYPE" != "standalone" ] && [ "$TYPE" != "subagent" ]; then
  echo "Error: type must be 'standalone' or 'subagent'"
  exit 1
fi

# Ensure agents.json exists
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" << 'EOF'
{
  "standalone": {},
  "subagents": {},
  "shared": {
    "image": "lobs-agent",
    "dockerfile": "Dockerfile.agent",
    "env": [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GH_TOKEN"
    ]
  }
}
EOF
fi

# Check if agent already exists in config
if python3 -c "
import json, sys
cfg = json.load(open('$CONFIG'))
section = 'standalone' if '$TYPE' == 'standalone' else 'subagents'
if '$NAME' in cfg.get(section, {}):
    sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
  echo "Agent '$NAME' already exists in $CONFIG"
  exit 1
fi

if [ "$TYPE" = "standalone" ]; then
  ROOT="$AGENTS_BASE/$NAME"

  if [ -d "$ROOT" ]; then
    echo "Directory $ROOT already exists. Remove it first or register manually."
    exit 1
  fi

  # Auto-assign port if not provided
  if [ -z "$PORT" ]; then
    # Find highest port in config and increment
    PORT=$(python3 -c "
import json
cfg = json.load(open('$CONFIG'))
ports = [a.get('port', 9430) for a in cfg.get('standalone', {}).values()]
print(max(ports) + 1 if ports else 9431)
")
    echo "Auto-assigned port: $PORT"
  fi

  echo "Creating standalone agent '$NAME' at $ROOT..."

  # Create directory structure
  mkdir -p "$ROOT/config/secrets"
  mkdir -p "$ROOT/agents/main/context/memory"
  mkdir -p "$ROOT/data"
  mkdir -p "$ROOT/media"

  # Copy subagent personality files
  for subagent in $(python3 -c "
import json
cfg = json.load(open('$CONFIG'))
print(' '.join(cfg.get('subagents', {}).keys()))
"); do
    if [ -d "$HOME/.lobs/agents/$subagent" ]; then
      mkdir -p "$ROOT/agents/$subagent"
      cp "$HOME/.lobs/agents/$subagent/SOUL.md" "$ROOT/agents/$subagent/SOUL.md" 2>/dev/null || true
      cp "$HOME/.lobs/agents/$subagent/AGENTS.md" "$ROOT/agents/$subagent/AGENTS.md" 2>/dev/null || true
    fi
  done

  # Discord config template
  cat > "$ROOT/config/discord.json" << 'DISC'
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
DISC

  # Discord token placeholder
  NAME_UPPER=$(echo "$NAME" | tr '[:lower:]' '[:upper:]')
  cat > "$ROOT/config/secrets/discord-token.json" << EOF
{
  "botToken": "REPLACE_WITH_${NAME_UPPER}_BOT_TOKEN"
}
EOF

  # Default model config
  cat > "$ROOT/config/models.json" << 'MODELS'
{
  "tiers": {
    "standard": "anthropic/claude-sonnet-4-20250514",
    "medium": "openrouter/minimax/minimax-m2.7",
    "small": "openrouter/anthropic/claude-3.5-haiku"
  }
}
MODELS

  # SOUL.md template
  DISPLAY_NAME="$(echo "$NAME" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  cat > "$ROOT/agents/main/SOUL.md" << EOF
# ${DISPLAY_NAME}

You are ${DISPLAY_NAME}, an AI agent powered by lobs-core.

## Personality
Describe your personality here.

## Voice
How you communicate.

## Work Style
How you approach tasks.
EOF

  # MEMORY.md stub
  cat > "$ROOT/agents/main/MEMORY.md" << 'MEM'
# MEMORY.md

## Context
Agent memory index. Updated as the agent learns.
MEM

  # Add to agents.json
  python3 -c "
import json
cfg = json.load(open('$CONFIG'))
cfg.setdefault('standalone', {})['$NAME'] = {
    'port': $PORT,
    'dataDir': '~/.lobs-agents/$NAME',
    'discord': True,
    'description': 'Discord agent'
}
json.dump(cfg, open('$CONFIG', 'w'), indent=2)
print('Added to agents.json')
"

  echo ""
  echo "✅ Standalone agent '$NAME' created"
  echo "   Data: $ROOT"
  echo "   Port: $PORT"
  echo ""
  echo "Next steps:"
  echo "  1. Edit $ROOT/agents/main/SOUL.md"
  echo "  2. Set Discord token in $ROOT/config/secrets/discord-token.json"
  echo "  3. Set guild/channel IDs in $ROOT/config/discord.json"
  echo "  4. Run: ./scripts/generate-compose.sh"

elif [ "$TYPE" = "subagent" ]; then
  SUBAGENT_DIR="$HOME/.lobs/agents/$NAME"

  echo "Creating subagent personality '$NAME'..."

  mkdir -p "$SUBAGENT_DIR"

  # Only create SOUL.md if it doesn't exist
  if [ ! -f "$SUBAGENT_DIR/SOUL.md" ]; then
    DISPLAY_NAME="$(echo "$NAME" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    cat > "$SUBAGENT_DIR/SOUL.md" << EOF
# ${DISPLAY_NAME}

You are a ${NAME} subagent.

## Role
Describe what this agent type specializes in.
EOF
  fi

  # Add to agents.json
  python3 -c "
import json
cfg = json.load(open('$CONFIG'))
cfg.setdefault('subagents', {})['$NAME'] = {
    'description': '$NAME subagent'
}
json.dump(cfg, open('$CONFIG', 'w'), indent=2)
print('Added to agents.json')
"

  # Copy to all existing standalone agents
  for agent_dir in "$AGENTS_BASE"/*/; do
    [ -d "$agent_dir" ] || continue
    agent=$(basename "$agent_dir")
    mkdir -p "$agent_dir/agents/$NAME"
    cp "$SUBAGENT_DIR/SOUL.md" "$agent_dir/agents/$NAME/SOUL.md" 2>/dev/null || true
    echo "  Copied to $agent"
  done

  echo ""
  echo "✅ Subagent '$NAME' created"
  echo "   SOUL: $SUBAGENT_DIR/SOUL.md"
  echo "   Propagated to all standalone agents"
fi

# Auto-regenerate compose if standalone
if [ "$TYPE" = "standalone" ] && [ -x "$SCRIPT_DIR/generate-compose.sh" ]; then
  echo ""
  echo "Regenerating docker-compose.agents.yml..."
  "$SCRIPT_DIR/generate-compose.sh"
fi
