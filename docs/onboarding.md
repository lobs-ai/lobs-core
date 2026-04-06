# lobs-core Onboarding Guide

How to set up your own instance of lobs-core — a personal AI agent runtime with Discord integration, memory, task management, and an orchestrator.

## Prerequisites

- **Node.js** v22+ (tested on v25.6)
- **npm** (comes with Node)
- **Git**
- **A Discord bot** — create one at [discord.com/developers](https://discord.com/developers/applications). Enable the Message Content intent under Bot settings. Invite it to your server with bot + application.commands scopes.
- **At least one LLM API key** — Anthropic (Claude) is the primary provider. OpenAI is optional.

## 1. Clone the repo

```bash
git clone https://github.com/lobs-ai/lobs-core.git
cd lobs-core
npm install
```

This also installs Playwright's Chromium (used for web fetching).

## 2. Create the config directory

lobs-core stores all runtime data under `LOBS_ROOT`, which defaults to `~/.lobs`. You can override it:

```bash
export LOBS_ROOT=~/.lobs   # or wherever you want
```

Create the directory structure:

```bash
mkdir -p $LOBS_ROOT/config/secrets
mkdir -p $LOBS_ROOT/agents/main/context/memory
mkdir -p $LOBS_ROOT/agents/{programmer,researcher,writer,reviewer,architect}
```

## 3. Configure identity

This tells lobs-core who the bot is and who owns it.

Create `$LOBS_ROOT/config/identity.json`:

```json
{
  "bot": {
    "name": "YourBot",
    "id": "yourbot"
  },
  "owner": {
    "name": "YourName",
    "id": "yourname",
    "discordId": "YOUR_DISCORD_USER_ID"
  }
}
```

- `bot.name` — display name (used in prompts, greetings)
- `bot.id` — lowercase identifier (used in DB records, task ownership)
- `owner.name` — your display name (used in system prompts)
- `owner.discordId` — your Discord user ID (right-click your name → Copy User ID with Developer Mode on)

## 4. Configure API keys

Create `$LOBS_ROOT/config/secrets/keys.json`:

```json
{
  "anthropic": "sk-ant-...",
  "openai": "sk-..."
}
```

At minimum you need `anthropic`. The `openai` key is optional (used for some voice features and embeddings).

## 5. Configure Discord

Create `$LOBS_ROOT/config/discord.json`:

```json
{
  "botToken": "YOUR_DISCORD_BOT_TOKEN",
  "guildId": "YOUR_PRIMARY_SERVER_ID",
  "ownerId": "YOUR_DISCORD_USER_ID",
  "enabled": true,
  "dmAllowFrom": [
    "YOUR_DISCORD_USER_ID"
  ],
  "botAllowFrom": [],
  "channels": {
    "alerts": "CHANNEL_ID_FOR_ALERTS",
    "agentWork": "CHANNEL_ID_FOR_AGENT_WORK",
    "completions": "CHANNEL_ID_FOR_COMPLETIONS"
  },
  "guildPolicies": {
    "YOUR_PRIMARY_SERVER_ID": {
      "allow": true,
      "requireMention": false
    }
  },
  "channelPolicies": {}
}
```

**Key fields:**
- `botToken` — from Discord Developer Portal → Bot → Token
- `guildId` — your Discord server ID (right-click server name → Copy Server ID)
- `ownerId` — same as your Discord user ID
- `dmAllowFrom` — user IDs allowed to DM the bot
- `botAllowFrom` — other bot user IDs the bot should respond to (e.g. another AI bot in the server)
- `channels.alerts` — where the bot sends alerts and notifications
- `channels.agentWork` — where subagent progress gets posted
- `channels.completions` — where task completions get announced
- `guildPolicies` — per-server: `allow` enables the bot, `requireMention` controls whether it only responds to @mentions
- `channelPolicies` — per-channel overrides (same format as guild policies)

You can set alerts/agentWork/completions to the same channel if you want everything in one place.

## 6. Configure models

Create `$LOBS_ROOT/config/models.json`:

```json
{
  "tiers": {}
}
```

This is for model tier overrides. An empty `tiers` object uses the defaults (Claude Sonnet for most tasks). To override a tier:

```json
{
  "tiers": {
    "medium": "openai/gpt-4o"
  }
}
```

Available tiers: `micro`, `small`, `medium`, `standard`, `strong`.

## 7. Configure git identity

Create `$LOBS_ROOT/config/lobs.json`:

```json
{
  "git": {
    "name": "YourBot",
    "email": "yourbot@example.com"
  }
}
```

This is used when the bot makes git commits on your behalf.

## 8. Set up the agent workspace

The main agent needs personality and context files. These define how the bot behaves.

### SOUL.md — the bot's personality

Create `$LOBS_ROOT/agents/main/SOUL.md`:

```markdown
# SOUL.md

You are [BotName], [OwnerName]'s personal AI agent.

[Write your bot's personality, communication style, rules, and boundaries here.
This is injected into every conversation as the system prompt.]
```

### USER.md — info about the owner

Create `$LOBS_ROOT/agents/main/USER.md`:

```markdown
# USER.md — About Your Human

- **Name:** YourName
- **Timezone:** America/New_York
[Add any context the bot should know about you — schedule, preferences, projects, etc.]
```

### MEMORY.md — persistent memory index

Create `$LOBS_ROOT/agents/main/MEMORY.md`:

```markdown
# MEMORY.md

## Projects
| Project | Status |
|---------|--------|

## System Notes
[The bot updates this file to track ongoing context across sessions.]
```

### TOOLS.md — tool reference

Create `$LOBS_ROOT/agents/main/TOOLS.md`:

```markdown
# TOOLS.md

[Document any custom tools, API access, or infrastructure the bot should know about.]
```

### IDENTITY.md — short identity reference

Create `$LOBS_ROOT/agents/main/IDENTITY.md`:

```markdown
name: YourBot
owner: YourName
```

## 9. Build and install the CLI

```bash
cd lobs-core
npm run build
```

To install the `lobs` CLI globally:

```bash
npm install -g .
```

This gives you the `lobs` command anywhere in your terminal.

## 10. Start it up

```bash
lobs start
```

Check that everything is healthy:

```bash
lobs status    # overview of server, tasks, workers
lobs health    # detailed health check (DB, memory, model availability)
lobs logs      # recent logs
```

Your bot should come online in Discord. Send it a message to verify.

## CLI Reference

| Command | What it does |
|---------|-------------|
| `lobs start` | Start lobs-core (daemonized) |
| `lobs stop` | Stop the running instance |
| `lobs restart` | Pull + build + restart (`--no-pull`, `--no-build` flags) |
| `lobs status` | System overview |
| `lobs health` | Detailed health check |
| `lobs logs [--tail N]` | Recent logs |
| `lobs logs follow` | Tail live logs |
| `lobs tasks list` | List active tasks |
| `lobs workers` | Show active/recent worker runs |
| `lobs chat` | Interactive chat in terminal |
| `lobs cron list` | Show scheduled jobs |
| `lobs models` | Diagnose model availability |
| `lobs config check` | Validate config files |

## Directory Structure Reference

```
$LOBS_ROOT/
├── config/
│   ├── identity.json       # Bot + owner identity
│   ├── discord.json         # Discord bot config
│   ├── models.json          # Model tier overrides
│   ├── lobs.json            # Git identity
│   └── secrets/
│       └── keys.json        # API keys
├── agents/
│   ├── main/                # Main agent workspace
│   │   ├── SOUL.md          # Personality
│   │   ├── USER.md          # Owner info
│   │   ├── MEMORY.md        # Persistent memory
│   │   ├── TOOLS.md         # Tool reference
│   │   ├── IDENTITY.md      # Short identity ref
│   │   ├── HEARTBEAT.md     # Heartbeat config (auto-managed)
│   │   ├── context/         # Project files, daily memory
│   │   │   └── memory/      # Daily memory files
│   │   └── sessions/        # Session transcripts
│   ├── programmer/          # Subagent workspaces
│   ├── researcher/
│   ├── writer/
│   ├── reviewer/
│   └── architect/
└── lobs.db                  # SQLite database (auto-created)
```

## Optional: Voice

If you want voice chat support, you'll need additional services (STT, TTS) and a `$LOBS_ROOT/config/voice.json`. This is not required for the core Discord text experience.

## Optional: Memory Server (lobs-memory)

For semantic search over memory and documents, you can run [lobs-memory](https://github.com/lobs-ai/lobs-memory) alongside lobs-core. It provides embeddings-based hybrid search on port 7420. Not required — lobs-core works without it, just with simpler keyword-based memory.

## Troubleshooting

**Bot doesn't respond in Discord:**
- Check `lobs logs` for errors
- Verify `discord.json` has `"enabled": true`
- Make sure the bot has Message Content intent enabled in Discord Developer Portal
- Check `guildPolicies` includes your server ID with `"allow": true`

**"No API key" errors:**
- Verify `$LOBS_ROOT/config/secrets/keys.json` exists and has valid keys
- Check key names match: `anthropic`, `openai`

**Database errors on first start:**
- The DB auto-creates on first run. If it fails, check write permissions on `$LOBS_ROOT/`

**CLI not found after `npm install -g .`:**
- Make sure your npm global bin is in your PATH: `npm bin -g`
