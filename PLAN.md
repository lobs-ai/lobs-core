# PAW Plugin — Migration Plan

## What This Is

A single OpenClaw plugin that replaces `lobs-server` entirely. Everything runs in-process
with OpenClaw — no separate Python server, no HTTP bridge, no polling.

## Scope

### What We're Porting (~38K lines Python → TypeScript)

**Core Data Layer** (models.py, schemas.py, database.py — ~2.4K lines)
- SQLite via better-sqlite3 + drizzle-orm
- Tables: tasks, projects, agents, inbox, worker_runs, workflows, workflow_runs, workflow_steps,
  scheduled_events, memories, knowledge, reflections, initiatives, usage_events, learning_entries
- Migration system

**Orchestrator** (~23K lines — the big one)
- `control_loop.py` → Plugin service with setInterval scan loop
- `worker_manager.py` → `subagent_spawning/ended` hooks + internal state
- `model_chooser.py` + `model_router.py` → `before_model_resolve` hook
- `prompter.py` + `prompt_enhancer.py` → `before_prompt_build` hook
- `workflow_executor.py` + `workflow_nodes.py` → Workflow engine service
- `workflow_seeds.py` → Seed workflows on first run
- `scanner.py` → Task scanner (part of control loop)
- `agent_tracker.py` → Agent state tracking
- `circuit_breaker.py` → Provider failure tracking
- `escalation.py` → Multi-tier failure escalation
- `git_manager.py` → Git operations for worker workspaces
- `reflection_cycle.py` → Post-task and periodic reflections
- `policy_engine.py` → Approval tier enforcement
- `budget_guard.py` → Cost tracking and limits
- `provider_health.py` → Provider reliability tracking
- `scheduler.py` → Cron-based workflow triggers

**API Routes** (~9K lines)
- All exposed via `registerHttpRoute` on the gateway
- Tasks, projects, agents, inbox, worker, workflows, status, calendar, research, etc.
- Mission Control + Mobile hit these directly

**Services** (~4K lines)
- `google_calendar.py` → Calendar integration
- `email_service.py` → Gmail integration
- `openclaw_bridge.py` → DELETE (we ARE OpenClaw now)
- `learning_service.py` → Agent learning/improvement tracking
- `task_tier.py` → Approval tier classification

### What We Delete

- `openclaw_bridge.py` — no more bridge, we're in-process
- `openclaw_models.py` — use OpenClaw's model catalog directly
- `middleware.py` — OpenClaw handles HTTP auth
- `main.py` (FastAPI) — replaced by plugin service registration
- All aiohttp/websocket reconnection code
- Worker gateway HTTP client — direct session spawn via plugin runtime

### What's New (not in lobs-server)

- `before_tool_call` hook for approval gating
- `/paw` slash command for quick status
- `openclaw paw` CLI subcommands
- Native sub-agent lifecycle management (no polling)

## Architecture

```
openclaw-plugin-paw/
├── openclaw.plugin.json          # Plugin manifest
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Plugin entry — register() wires everything
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema (all tables)
│   │   ├── migrate.ts            # Auto-migration on startup
│   │   └── connection.ts         # SQLite connection management
│   ├── orchestrator/
│   │   ├── control-loop.ts       # Main scan/dispatch loop (service)
│   │   ├── scanner.ts            # Find ready tasks
│   │   ├── worker-manager.ts     # Spawn/track/complete workers
│   │   ├── model-chooser.ts      # Model selection + fallback chains
│   │   ├── prompter.ts           # Build agent prompts + learning
│   │   ├── agent-tracker.ts      # Agent state + capabilities
│   │   ├── circuit-breaker.ts    # Provider failure tracking
│   │   ├── escalation.ts         # Multi-tier failure handling
│   │   ├── git-manager.ts        # Workspace git operations
│   │   ├── policy-engine.ts      # Approval tiers (auto/lobs/rafe)
│   │   ├── budget-guard.ts       # Cost tracking + limits
│   │   └── provider-health.ts    # Provider reliability
│   ├── workflow/
│   │   ├── engine.ts             # DAG executor
│   │   ├── nodes.ts              # Node type implementations
│   │   ├── seeds.ts              # Default workflow definitions
│   │   ├── scheduler.ts          # Cron-triggered workflows
│   │   └── functions.ts          # Callable functions for nodes
│   ├── hooks/
│   │   ├── model-resolve.ts      # before_model_resolve → ModelChooser
│   │   ├── prompt-build.ts       # before_prompt_build → Prompter
│   │   ├── subagent.ts           # subagent_spawning/ended → WorkerManager
│   │   ├── tool-gate.ts          # before_tool_call → PolicyEngine
│   │   └── agent-end.ts          # agent_end → reflection triggers
│   ├── api/
│   │   ├── tasks.ts
│   │   ├── projects.ts
│   │   ├── agents.ts
│   │   ├── inbox.ts
│   │   ├── worker.ts
│   │   ├── workflows.ts
│   │   ├── status.ts
│   │   ├── calendar.ts
│   │   └── index.ts              # Route registration helper
│   ├── integrations/
│   │   ├── google-calendar.ts
│   │   ├── gmail.ts
│   │   └── github.ts
│   ├── services/
│   │   ├── reflection.ts
│   │   ├── learning.ts
│   │   └── brief.ts
│   └── util/
│       ├── logger.ts
│       └── types.ts
└── tests/
    └── ...
```

## Execution Plan

### Phase 1: Foundation (Day 1-2)
**Goal:** Plugin boots, DB initializes, basic API responds

1. Scaffold package (tsconfig, package.json, manifest)
2. Set up SQLite with drizzle-orm (schema for tasks, projects, agents)
3. Plugin entry point — register service, register HTTP routes
4. Basic CRUD API: tasks, projects, agents
5. Verify: `openclaw` loads plugin, `/paw/api/tasks` returns data

### Phase 2: Orchestrator Core (Day 3-5)
**Goal:** Tasks get picked up and dispatched to workers

1. Control loop service (scan every 10s)
2. Scanner (find tasks ready for work)
3. Worker manager (spawn via OpenClaw sessions, track active workers)
4. `subagent_spawning` + `subagent_ended` hooks
5. Agent tracker (capabilities, status per agent type)
6. Basic model chooser (`before_model_resolve` hook)
7. Verify: create task → orchestrator spawns worker → task completes

### Phase 3: Workflow Engine (Day 6-8)
**Goal:** DAG-based task execution with branching

1. Workflow engine (step executor, state machine)
2. Node types: spawn_agent, tool_call, branch, gate, notify, cleanup
3. Seed workflows (task-router, agent-assignment, scan-unassigned)
4. Scheduler (cron-triggered workflows)
5. Workflow API routes
6. Verify: unassigned task → scan → assign → route → spawn → complete

### Phase 4: Intelligence Layer (Day 9-11)
**Goal:** Smart model routing, prompts, reflections

1. Full model chooser (tier-based, per-agent fallback chains, provider health)
2. Prompter (build agent prompts with learning context)
3. Circuit breaker + provider health tracking
4. Policy engine (approval tiers)
5. Budget guard (cost tracking)
6. Reflection cycle (post-task + periodic)
7. Escalation (multi-tier failure handling)

### Phase 5: Integrations + API Parity (Day 12-14)
**Goal:** Feature parity with lobs-server

1. Remaining API routes (inbox, status, calendar, research, documents)
2. Google Calendar integration
3. Gmail integration
4. CLI commands (`openclaw paw tasks list`, etc.)
5. Slash commands (`/tasks`, `/status`, `/inbox`)
6. Migration tool: import existing SQLite data from lobs-server

### Phase 6: Cutover (Day 15)
**Goal:** Replace lobs-server

1. Update Mission Control to point at `/paw/api/*`
2. Update Mobile to point at `/paw/api/*`
3. Update workspace files
4. Stop lobs-server
5. Monitor

## Key Decisions

- **ORM:** drizzle-orm (TypeScript-native, SQLite support, migrations)
- **HTTP:** Use OpenClaw's built-in HTTP server via `registerHttpRoute`
- **Auth:** Piggyback on OpenClaw's gateway auth (token-based)
- **State dir:** `~/.openclaw/plugins/paw/` for DB + config
- **API prefix:** `/paw/api/` to avoid conflicts
- **No Python:** Everything in TypeScript. Clean break.

## LOC Estimate

| Component | Python LOC | Est. TS LOC | Notes |
|---|---|---|---|
| DB schema + migrations | 2,370 | 800 | Drizzle is more concise |
| Orchestrator | 23,367 | 12,000 | Less boilerplate, no bridge |
| API routes | 8,982 | 5,000 | Simpler handlers |
| Services | 3,965 | 2,500 | Direct integration |
| Hooks + glue | 0 | 1,500 | New — OpenClaw lifecycle wiring |
| **Total** | **38,684** | **~21,800** | ~44% reduction |
