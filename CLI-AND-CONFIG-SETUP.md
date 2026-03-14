# CLI, Config Validation, and Runtime Failsafes

**Completed:** 2026-03-13

## What Was Built

### 1. `lobs` CLI Tool (`src/cli/lobs.ts`)

A command-line interface for managing lobs-core that talks to the running server at `localhost:9420`.

**Commands:**
- `lobs status` — System overview (tasks, workers, uptime, health)
- `lobs tasks [list|view]` — Manage tasks
- `lobs workers` — Show active/recent worker runs  
- `lobs config check` — Validate all config files
- `lobs config show` — Show config directory structure and file status
- `lobs health` — Detailed health check (DB, memory server, LM Studio)
- `lobs logs [--tail N]` — Show recent logs (placeholder for now)
- `lobs init` — Initialize config directory structure with templates

**Features:**
- ANSI colored output (no external dependencies)
- Simple manual argument parsing (no CLI framework needed)
- Friendly error messages when server is unreachable
- Installed globally via `npm link` → `/opt/homebrew/bin/lobs`

### 2. Config/Secrets Separation

Refactored config system to separate committable configuration from secrets:

```
~/.lobs/config/              ← Safe to commit to GitHub
  .gitignore                 ← Ignores secrets/ directory
  models.json                ← Model tiers, agent chains (no secrets)
  discord.json               ← Guild IDs, channel policies (no secrets)
  lobs.json                  ← General settings (optional, future)
  
  secrets/                   ← GITIGNORED — never committed
    keys.json                ← API keys (Anthropic, OpenRouter, etc.)
    discord-token.json       ← { "botToken": "..." }
```

**Backwards Compatibility:**
- Old layout (secrets in config root) still works
- Deprecation warnings guide migration to new layout
- Config loaders check `secrets/` first, fall back to old paths

**Migration Path:**
1. Run `lobs init` to create new directory structure
2. Move `keys.json` → `secrets/keys.json`
3. Extract `botToken` from `discord.json` → `secrets/discord-token.json`
4. Remove `botToken` from `discord.json`
5. Run `lobs config check` to verify

### 3. Config Validation (`src/config/validator.ts`)

Validates all config files on startup and via CLI.

**Validates:**
- `models.json` — Required tiers, agent configs, type checking
- `discord.json` — Structure, channel policies (warns if botToken present)
- `secrets/keys.json` — Pool structure, key arrays
- `secrets/discord-token.json` — botToken presence and type

**Features:**
- Errors vs. warnings (non-critical issues don't fail validation)
- Secrets status check without printing values
- Legacy layout detection with migration suggestions
- Pretty-printed results with ✓/✗ indicators

**Usage:**
```bash
lobs config check  # Validate all configs
lobs init          # Create directory structure with templates
```

### 4. Updated Config Loaders

**`src/config/discord.ts`:**
- Loads `botToken` from `secrets/discord-token.json` (new) or `discord.json` (legacy)
- Warns on legacy usage
- Falls back to `DISCORD_BOT_TOKEN` env var

**`src/config/keys.ts`:**
- Loads from `secrets/keys.json` (new) or `keys.json` (legacy)
- Warns on legacy usage
- Environment variables still override config files

### 5. Runtime Failsafes (`src/main.ts`)

Added production-grade error handling and startup checks:

**Uncaught Exception Handler:**
- Logs errors instead of crashing
- Only exits for truly fatal errors (DB corruption, OOM)
- Gracefully degrades for API failures, network timeouts

**Unhandled Rejection Handler:**
- Logs unhandled promise rejections
- Continues execution (don't crash on failed API calls)

**PID File Management:**
- Writes `~/.lobs/lobs.pid` on startup
- Checks for existing PID (detects double-run attempts)
- Cleans up on shutdown

**Startup Checks:**
- Config validation with warnings (doesn't block startup)
- DB directory creation
- Legacy layout warnings

**Graceful Shutdown:**
- Cleans up PID file
- Stops services (browser, Discord, cron, control loop)
- Closes DB connection cleanly

### 6. Health Endpoint (`src/api/health.ts`)

New `/api/health` endpoint for monitoring:

**Returns:**
```json
{
  "status": "healthy",
  "uptime": 12345,
  "pid": 72710,
  "db": "ok",
  "memory_server": "ok",
  "lm_studio": "down"
}
```

**Checks:**
- Database file existence
- lobs-memory server (http://localhost:7420)
- LM Studio server (http://localhost:1234)
- Current PID from PID file

**Used by:**
- CLI `lobs health` command
- External monitoring tools
- Healthcheck scripts

## Files Changed

```
src/cli/lobs.ts              ← NEW CLI tool
src/config/validator.ts      ← NEW config validation
src/api/health.ts            ← NEW health endpoint
src/main.ts                  ← Added failsafes, PID management, validation
src/api/router.ts            ← Wired /api/health endpoint
src/config/discord.ts        ← Load botToken from secrets/
src/config/keys.ts           ← Load from secrets/keys.json
package.json                 ← Added lobs bin entry
```

## Installation

```bash
cd ~/lobs/lobs-core
npm run build
npm link  # Installs lobs globally
```

## Usage

```bash
# Initialize config structure (first time)
lobs init

# Validate config
lobs config check

# Check system status
lobs status

# View active tasks
lobs tasks

# Health check
lobs health

# Show config layout
lobs config show
```

## Next Steps

1. **Log streaming:** Implement `lobs logs` to tail logs from the server
2. **Task management:** Add `lobs tasks create/view/update` commands
3. **Worker control:** Add `lobs workers kill/restart` commands
4. **Config editing:** Add `lobs config edit <file>` to open configs in $EDITOR
5. **Backup/restore:** Add `lobs backup` and `lobs restore` for DB snapshots
6. **Metrics:** Add `lobs metrics` for token usage, costs, success rates

## Testing

All changes tested on macOS (lobs-mac-mini):
- ✅ Config validation (both layouts)
- ✅ CLI installation via npm link
- ✅ ANSI colors in terminal
- ✅ Health endpoint (/api/health)
- ✅ Backwards compatibility with old config layout
- ✅ Deprecation warnings for legacy layout
- ✅ lobs init creates directory structure + .gitignore
- ✅ Server startup with config validation

## Commit

```
feat: CLI, config validation, runtime failsafes

- Created lobs CLI for managing lobs-core
- Split config from secrets (committable vs gitignored)
- Config validation with errors/warnings
- Runtime failsafes (uncaught exceptions, PID file, graceful shutdown)
- Health endpoint for monitoring
- Backwards compat with legacy config layout
```

Pushed to `main` at commit `23804a0`.
