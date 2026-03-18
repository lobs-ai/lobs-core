# lobs-core

Personal AI agent system. Runs standalone — orchestrates worker agents with its own LLM execution loop, context engine, and memory search.

## Architecture

```
lobs-core/
├── src/               ← The engine
│   ├── runner/        ← Agent execution (LLM loop, tools, providers)
│   ├── orchestrator/  ← Control loop, model routing, worker lifecycle
│   ├── workflow/      ← Task routing, scheduling, workflow engine
│   ├── db/            ← SQLite database (drizzle-orm)
│   └── main.ts        ← Standalone entry point
├── memory/            ← Submodule: lobs-memory (semantic search server)
├── nexus/             ← Submodule: lobs-nexus (web dashboard)
└── tests/             ← Integration + unit tests
```

### Submodules

| Module | Repo | Purpose |
|--------|------|---------|
| `memory/` | [lobs-ai/lobs-memory](https://github.com/lobs-ai/lobs-memory) | Semantic search: BM25 + vector + neural reranking |
| `nexus/` | [lobs-ai/lobs-nexus](https://github.com/lobs-ai/lobs-nexus) | Web dashboard (React/Vite) |

### Separate repos

| Repo | Purpose |
|------|---------|
| [lobs-ai/lobs-memory-plugin](https://github.com/lobs-ai/lobs-memory-plugin) | lobs plugin for memory tools (thin HTTP proxy) |

## Quick Start

```bash
# 1. Clone and install
#    NOTE: postinstall runs `npx playwright install --with-deps chromium`
#    automatically — no manual browser install needed.
git clone https://github.com/lobs-ai/lobs-core.git
cd lobs-core
npm install       # ← also downloads Playwright's Chromium browser (~120MB)
npm run build

# 2. Initialize config (creates ~/.lobs/config/ with templates)
lobs init

# 3. Add your API keys
#    Edit ~/.lobs/config/secrets/keys.json
#    Edit ~/.lobs/config/secrets/discord-token.json (optional)

# 4. Validate config
lobs config check

# 5. Start
lobs start
```

## CLI

After `npm link`, the `lobs` command is available globally:

```bash
# Process management
lobs start                  # Start lobs-core (daemonized, logs to ~/.lobs/lobs.log)
lobs stop                   # Graceful shutdown (SIGTERM, falls back to SIGKILL)
lobs restart                # Stop + start
lobs status                 # System overview (tasks, workers, uptime)
lobs health                 # Health check (DB, memory server, LM Studio)

# Tasks & workers
lobs tasks                  # List active tasks
lobs workers                # Recent worker runs

# Config
lobs config check           # Validate all config files
lobs config show            # Show config directory structure
lobs init                   # Create config dirs + skeleton files

# Logs
lobs logs                   # Last 50 lines of log
lobs logs --tail 200        # Last 200 lines
```

## Config

Config lives in `~/.lobs/config/`. Secrets are separated into a gitignored subfolder so you can safely commit your config:

```
~/.lobs/config/                  ← committable
  models.json                    ← model tiers, agent chains, costs
  discord.json                   ← guild/channel config (no token)
  .gitignore                     ← ignores secrets/
  secrets/                       ← NEVER committed
    keys.json                    ← API keys (anthropic, openrouter, etc.)
    discord-token.json           ← { "botToken": "..." }
```

Run `lobs init` to create this structure with templates. Run `lobs config check` to validate.

## Running (manual)

```bash
# Build
npm run build

# Run in foreground (useful for debugging)
node dist/main.js

# Run tests
npm test
```

## Agent Runner

The runner calls LLM APIs directly with in-process tool execution:

- **Anthropic** — native API with OAuth token auth
- **LM Studio** — local models via OpenAI-compatible API
- **OpenRouter** — cloud model routing
- **Any OpenAI-compatible** endpoint

### Tools available to agents

`exec`, `read`, `write`, `edit`, `web_search`, `web_fetch`, `memory_search`, `memory_read`

### Draft Generation

Nexus plugin affordances support local-first draft generation for boilerplate work:

- commit messages
- PR descriptions
- doc stubs
- test scaffolding

The intended flow is fast local draft first, then optional refinement by a stronger model or manual editing.

### Context Engine

Before each agent run, the context engine:
1. Classifies the task (coding/debugging/architecture/review/research/docs/devops)
2. Allocates token budget per category
3. Searches lobs-memory for relevant context (decisions, learnings, project docs)
4. Assembles a structured prompt with workspace files + injected context

## Legacy

`src/hooks/`, `src/api/`, `src/services/`, `src/integrations/`, `src/index.ts` — lobs plugin infrastructure. The standalone entry point is `src/main.ts`.
