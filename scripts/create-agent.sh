#!/bin/bash
# create-agent.sh — Initialize a new lobs-core agent instance
#
# Usage:
#   ./scripts/create-agent.sh <name> [port]
#
# Example:
#   ./scripts/create-agent.sh briggs 9431
#   ./scripts/create-agent.sh sam 9432

set -euo pipefail

NAME="${1:-}"
PORT="${2:-9421}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <agent-name> [port]"
  echo "Example: $0 briggs 9431"
  exit 1
fi

ROOT="$HOME/.lobs-agents/$NAME"

if [ -d "$ROOT" ]; then
  echo "Agent '$NAME' already exists at $ROOT"
  echo "Delete it first if you want to recreate: rm -rf $ROOT"
  exit 1
fi

echo "Creating agent '$NAME' at $ROOT..."

# Create directory structure
mkdir -p "$ROOT/config/secrets"
mkdir -p "$ROOT/agents/main/context/memory"
mkdir -p "$ROOT/data"
mkdir -p "$ROOT/media"

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
  "botToken": "REPLACE_WITH_${NAME^^}_BOT_TOKEN"
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

echo ""
echo "✅ Agent '$NAME' created at $ROOT"
echo ""
echo "Next steps:"
echo "  1. Edit $ROOT/agents/main/SOUL.md with the agent's personality"
echo "  2. Create a Discord bot and put the token in:"
echo "     $ROOT/config/secrets/discord-token.json"
echo "  3. Set guild/channel IDs in $ROOT/config/discord.json"
echo "  4. Add to docker-compose.agents.yml:"
echo ""
echo "  $NAME:"
echo "    <<: *agent-base"
echo "    container_name: lobs-agent-$NAME"
echo "    environment:"
echo "      <<: *agent-env"
echo "      AGENT_NAME: $NAME"
echo "      LOBS_ROOT: /data"
echo "      LOBS_PORT: \"9421\""
echo "      DISCORD_BOT_TOKEN: \${${NAME^^}_DISCORD_TOKEN:-}"
echo "    ports:"
echo "      - \"$PORT:9421\""
echo "    volumes:"
echo "      - \${HOME}/.lobs-agents/$NAME:/data"
echo "      - $NAME-workspace:/home/agent"
echo ""
echo "  And add '$NAME-workspace:' to the volumes section."
