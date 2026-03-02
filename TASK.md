# Implementation Task for Claude Code

## Context
You are working on `openclaw-plugin-paw` — an OpenClaw plugin that replaces a Python FastAPI server (lobs-server).
The plugin scaffold is already in place. You need to fill in the real implementation.

## Reference Code
- **Python source to port:** `~/lobs-server/app/orchestrator/` (workflow engine, worker manager, model chooser, etc.)
- **Python models:** `~/lobs-server/app/models.py`
- **Python routes:** `~/lobs-server/app/routers/`
- **OpenClaw plugin SDK types:** `~/openclaw-src/src/plugins/runtime/types.ts`
- **OpenClaw plugin examples:** `~/openclaw-src/extensions/memory-lancedb/index.ts`
- **Workflow seeds (all workflows):** `~/lobs-server/app/orchestrator/workflow_seeds.py`

## What to Build

### 1. Fix DB Layer — Use Drizzle ORM Properly
The current `src/db/migrate.ts` uses raw SQL CREATE TABLE statements. Replace with proper drizzle-kit migrations.
- Use `drizzle-orm/better-sqlite3` for all queries (no raw SQL)
- The schema in `src/db/schema.ts` is the source of truth
- For migration, use `migrate()` from `drizzle-orm/better-sqlite3/migrator` or use `db.run(sql\`...\`)` to create tables from schema introspection

### 2. Implement Workflow Engine (`src/workflow/`)
Port from `~/lobs-server/app/orchestrator/workflow_executor.py` and `workflow_nodes.py`.

Key files:
- `src/workflow/engine.ts` — WorkflowExecutor class that advances runs one step at a time
- `src/workflow/nodes.ts` — Node type handlers (spawn_agent, tool_call, branch, gate, notify, cleanup, expression, delay, python_call→ts_call, llm_route, send_to_session)
- `src/workflow/functions.ts` — Expression evaluation functions (workerCapacity, activeWorkers, numTasks, taskField, agentStatus, numUnread, hour, dayOfWeek, ctx, contains)
- `src/workflow/seeds.ts` — All default workflow definitions (port from workflow_seeds.py)
- `src/workflow/scheduler.ts` — Cron-based schedule trigger checking

**Simplifications over Python version:**
- No need for `flag_modified()` — drizzle handles this
- No async retry-on-lock pattern — better-sqlite3 is synchronous, WAL mode handles concurrency
- `python_call` nodes become `ts_call` nodes — direct TypeScript function calls instead of dynamic Python imports
- Use OpenClaw's `sessions_spawn` equivalent for `spawn_agent` nodes (check the plugin runtime API)

### 3. Implement Orchestrator Core (`src/orchestrator/`)
- `control-loop.ts` — Service that runs on interval: get active runs → advance each → process events → process schedules
- `scanner.ts` — Find tasks ready for work (status=active, agent assigned, no active workflow run)
- `worker-manager.ts` — Track active workers, enforce max concurrent, project locks
- `model-chooser.ts` — Model tier resolution with per-agent fallback chains
- `agent-tracker.ts` — Agent capabilities and status tracking

### 4. Implement API Routes (`src/api/`)
Fill in the stub routes with real drizzle queries:
- `projects.ts` — Full CRUD for projects
- `agents.ts` — List/get agent profiles and status
- `status.ts` — System overview (open tasks, active workers, recent runs)
- `inbox.ts` — CRUD for inbox items
- `worker.ts` — Worker status, run history
- `workflows.ts` — Workflow definitions, runs, manual triggers

### 5. Implement Hooks (`src/hooks/`)
- `model-resolve.ts` — Intercept model selection, apply tier-based routing
- `subagent.ts` — On spawn: record worker run. On end: update task, record results
- `tool-gate.ts` — Check approval tiers before dangerous tool calls
- `agent-end.ts` — Trigger post-task reflection

### 6. Seed Workflows (`src/workflow/seeds.ts`)
Port ALL workflows from `~/lobs-server/app/orchestrator/workflow_seeds.py`:
- task-router (master router with CI pipeline for programmer)
- agent-assignment (LLM-based agent assignment)
- scan-unassigned (periodic scan)
- calendar-sync, email-check
- tracker-deadlines, tracker-daily-summary
- daily-learning, create-learning-plan
- reflection-cycle, daily-compression, diagnostic-scan
- review-sweep, doc-upkeep
- scheduled-events, github-sync, memory-sync
- system-cleanup, inbox-processing

**IMPORTANT:** Convert `python_call` nodes to `ts_call` nodes. The callable functions need TypeScript implementations in `src/workflow/functions.ts` or dedicated service files.

## Principles
1. **ORM everywhere** — No raw SQL. Use drizzle query builders for all DB access.
2. **Type safety** — Leverage TypeScript types. Define proper interfaces for workflow nodes, results, context.
3. **Simplify** — We're inside OpenClaw now. Use its session management, model routing, and HTTP server directly instead of bridging.
4. **No async retry-on-lock** — The Python code has retry loops everywhere because of async SQLite locking issues. better-sqlite3 is synchronous + WAL. Remove all that complexity.
5. **Error handling** — Use proper try/catch, no silent swallowing. Log errors via plugin logger.

## What NOT to Do
- Don't install dependencies yet (just write the code)
- Don't worry about tests yet
- Don't implement integrations (google calendar, gmail, github) — those are Phase 5
- Don't implement the learning service — that's Phase 4

## File Structure
All code goes in `/Users/lobs/openclaw-plugin-paw/src/`. Follow the existing directory structure.
