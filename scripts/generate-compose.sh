#!/bin/bash
# generate-compose.sh — Generate docker-compose.agents.yml from agents.json
#
# Reads ~/.lobs/agents.json and generates compose entries for all standalone agents.
# Subagent-only types are ignored (they don't need containers).
#
# Usage:
#   ./scripts/generate-compose.sh

set -euo pipefail

CONFIG="$HOME/.lobs/agents.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.agents.yml"

if [ ! -f "$CONFIG" ]; then
  echo "No agents.json found at $CONFIG"
  echo "Create agents first: ./scripts/create-agent.sh <name> standalone"
  exit 1
fi

# Use python3 to read JSON and generate the compose file
python3 << 'PYEOF'
import json, os

config_path = os.path.expanduser("~/.lobs/agents.json")
with open(config_path) as f:
    cfg = json.load(f)

standalone = cfg.get("standalone", {})
shared = cfg.get("shared", {})

if not standalone:
    print("No standalone agents in agents.json")
    raise SystemExit(1)

env_vars = shared.get("env", [])
dockerfile = shared.get("dockerfile", "Dockerfile.agent")

lines = []
lines.append("# docker-compose.agents.yml — Auto-generated from ~/.lobs/agents.json")
lines.append("# DO NOT EDIT — regenerate with: ./scripts/generate-compose.sh")
lines.append("")
lines.append("x-agent-base: &agent-base")
lines.append("  build:")
lines.append("    context: .")
lines.append(f"    dockerfile: {dockerfile}")
lines.append("  restart: unless-stopped")
lines.append("  environment: &agent-env")
for var in env_vars:
    lines.append("    " + var + ": ${" + var + ":-}")
lines.append("")
lines.append("services:")

volume_names = []

for name, agent in sorted(standalone.items()):
    port = agent.get("port", 9421)
    data_dir = agent.get("dataDir", f"~/.lobs-agents/{name}")
    # Expand ~ to ${HOME} for compose compatibility
    data_dir = data_dir.replace("~", "${HOME}")
    token_var = f"{name.upper()}_DISCORD_TOKEN"

    lines.append(f"  {name}:")
    lines.append("    <<: *agent-base")
    lines.append(f"    container_name: lobs-agent-{name}")
    lines.append("    environment:")
    lines.append("      <<: *agent-env")
    lines.append(f"      AGENT_NAME: {name}")
    lines.append("      LOBS_ROOT: /data")
    lines.append('      LOBS_PORT: "9421"')
    lines.append("      DISCORD_BOT_TOKEN: ${" + token_var + ":-}")

    # Add any custom env vars
    for k, v in agent.get("env", {}).items():
        lines.append(f"      {k}: {v}")

    lines.append("    ports:")
    lines.append(f'      - "{port}:9421"')
    lines.append("    volumes:")
    lines.append(f"      - {data_dir}:/data")
    lines.append(f"      - {name}-workspace:/home/agent")
    lines.append("")

    volume_names.append(f"{name}-workspace")

lines.append("volumes:")
for v in sorted(volume_names):
    lines.append(f"  {v}:")
lines.append("")

output_path = os.environ["COMPOSE_FILE"]

with open(output_path, "w") as f:
    f.write("\n".join(lines))

print(f"✅ Generated {output_path}")
print()
print("Standalone agents:")
for name, agent in sorted(standalone.items()):
    port = agent.get("port", 9421)
    desc = agent.get("description", "")
    print(f"  - {name} (port {port}) {desc}")

print()
subagents = cfg.get("subagents", {})
if subagents:
    print(f"Subagent personalities ({len(subagents)}): {', '.join(sorted(subagents.keys()))}")
    print("  (these don't need containers — loaded in-process by standalone agents)")
PYEOF
