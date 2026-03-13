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
| [lobs-ai/lobs-memory-plugin](https://github.com/lobs-ai/lobs-memory-plugin) | OpenClaw plugin for memory tools (thin HTTP proxy) |

## Running

```bash
# Build
npm run build

# Run standalone
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

### Context Engine

Before each agent run, the context engine:
1. Classifies the task (coding/debugging/architecture/review/research/docs/devops)
2. Allocates token budget per category
3. Searches lobs-memory for relevant context (decisions, learnings, project docs)
4. Assembles a structured prompt with workspace files + injected context

## Legacy

`src/hooks/`, `src/api/`, `src/services/`, `src/integrations/`, `src/index.ts` — OpenClaw plugin infrastructure, kept for reference. The standalone entry point is `src/main.ts`.
