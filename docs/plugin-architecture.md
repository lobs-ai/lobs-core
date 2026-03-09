# PAW Plugin Architecture

*Last updated: 2026-03-09*

## What Is a Plugin?

OpenClaw plugins are Node/TypeScript modules that extend the Gateway daemon at runtime. Each plugin exports a single object with `id`, `name`, `version`, and a `register(api)` method. The Gateway calls `register` on startup, passing a plugin API surface that provides: path resolution, config access, logger, route registration, and lifecycle hook registration.

**Plugin contract (simplified):**
```ts
const myPlugin = {
  id: "my-plugin",
  register(api: PluginApi) {
    // register routes, hooks, background services
  }
};
export default myPlugin;
```

## File/Directory Structure

```
openclaw-plugin-lobs/
├── openclaw.plugin.json    # Plugin manifest (id, name, configSchema)
├── package.json
├── dist/                   # Compiled output loaded by Gateway
│   ├── index.js            # Plugin entry point — exports pawPlugin
│   ├── api/                # REST route handlers (/paw/api/*)
│   ├── orchestrator/       # Control loop, worker manager, model chooser
│   ├── db/                 # SQLite connection + migrations
│   ├── hooks/              # Lifecycle hooks (model-resolve, prompt-build, tool-gate, agent-end, …)
│   ├── services/           # Background services (memory scanner, YouTube, etc.)
│   ├── workflow/           # Workflow engine + seeds
│   └── util/               # Logger, helpers
├── addons/                 # Skill add-ons (tasks/, projects/, …)
└── docs/                   # Architecture docs
```

**`openclaw.plugin.json`** declares the plugin ID and `configSchema` (JSON Schema). Config values are set in the Gateway UI and passed to `register` as `api.pluginConfig`.

## How Plugins Register

On Gateway start, OpenClaw discovers plugins by scanning configured plugin paths. For each found plugin it:

1. Loads the JS module at `dist/index.js`
2. Calls `plugin.register(api)` synchronously
3. Routes, hooks, and background services declared inside `register` become active immediately

The PAW plugin's `register` function does, in order:
- Init SQLite DB + run migrations
- Startup recovery (resume in-flight workers, reset stale workflow runs)
- Seed default workflows
- Register REST routes at `/paw/api/*`
- Register lifecycle hooks (model-resolve, prompt-build, subagent, tool-gate, agent-end, circuit-breaker, compaction, restart-continuation)
- Start the orchestrator control loop
- Start background services (memory scanner, YouTube service)

## What the PAW Plugin Provides

| Capability | Details |
|---|---|
| **Orchestrator** | Control loop scans for `active` tasks, selects agent type + model tier, spawns workers via `sessions_spawn`, monitors completion |
| **Task DB** | Full task lifecycle: create → active → done/failed, with retry, escalation, and crash tracking |
| **Agent templates** | Per-agent-type workspace, model, and tool configs (programmer, writer, researcher, reviewer, architect) |
| **Inbox** | Notices and action items surfaced to agents; tracks read/unread and action status |
| **Research memos** | Structured research outputs linked to initiatives: problem, decision, rationale, MVP scope |
| **Workflow engine** | DAG-based workflow definitions; workflow runs with step tracking and subscriptions |
| **API layer** | ~20 REST modules at `/paw/api/*` (tasks, projects, agents, inbox, research, meetings, chat, etc.) |
| **Lifecycle hooks** | Intercept model selection, prompt build, tool access, agent completion, and session compaction |

## DB Schema Overview

**`tasks`** — Core work queue. Key fields: `id`, `title`, `status` (active/done/failed), `agent` (agent type), `model_tier`, `work_state` (not_started/in_progress/done), `notes`, `context_refs` (JSON array of file paths injected into worker context), `project_id`, `retry_count`, `failure_reason`.

**`projects`** — Grouping container for tasks. Fields: `id`, `title`, `type`, `repo_path`, `github_repo`, `archived`.

**`worker_runs`** — One row per agent spawn. Tracks `task_id`, `agent_type`, `model`, `started_at`/`ended_at`, token counts, cost, `succeeded`, `summary`, and `child_session_key` (links to the live Gateway session).

**`agent_status`** — One row per agent type. Fields: `status`, `activity`, `current_task_id`, `last_active_at`. Used by the orchestrator to enforce concurrency limits.

**`inbox_items`** — Notices and action items for agents. Fields: `id`, `title`, `content`, `type`, `requires_action`, `action_status`, `source_agent`, `is_read`.

**`research_memos`** — Structured research outputs. Fields: `initiative_id`, `problem`, `user_segment`, `mvp_scope`, `decision`, `rationale`, `stale_flagged`.

## Related Docs

- [Orchestrator Flow](orchestrator-flow.md)
- [Model Chooser](model-chooser.md)
