# openclaw-plugin-paw

**Personal AI Workforce** — a multi-agent orchestration plugin for OpenClaw.

Replaces `lobs-server` (Python/FastAPI) with a single TypeScript plugin that runs inside OpenClaw. No separate server, no HTTP bridge, no polling.

## What It Does

- **Task Management** — CRUD for tasks and projects with status tracking
- **Workflow Engine** — DAG-based task execution with branching, gates, retries
- **Agent Orchestration** — Spawn, track, and manage specialist workers (programmer, researcher, writer, architect, reviewer)
- **Model Routing** — Tier-based model selection (micro→strong) with per-agent fallback chains
- **Approval Tiers** — Auto/Lobs/Rafe approval gating on dangerous operations
- **Reflection Cycle** — Post-task and periodic agent reflections with learning extraction
- **Integrations** — Google Calendar, Gmail, GitHub sync
- **API** — Full REST API for Mission Control and Mobile clients

## Architecture

    OpenClaw Gateway
      └── PAW Plugin (this)
            ├── Hooks (model-resolve, subagent, tool-gate, prompt-build, agent-end)
            ├── Services (orchestrator control loop, reflection cycle)
            ├── HTTP Routes (/paw/api/*)
            ├── Workflow Engine (DAG executor + 19 default workflows)
            └── SQLite (better-sqlite3 + drizzle-orm)

## Config

In your OpenClaw config:

    plugins:
      paw:
        dbPath: ~/.openclaw/plugins/paw/paw.db
        scanIntervalMs: 10000
        maxConcurrentWorkers: 2
        defaultModelTier: standard

## API

All routes under /paw/api/ — tasks, projects, agents, inbox, worker, workflows, status.

## Data Migration

    OLD_DB=~/lobs-server/lobs.db NEW_DB=~/.openclaw/plugins/paw/paw.db npx tsx src/util/migrate-data.ts

## Development

    npm install
    npm run build
    npm run dev
    npm test
