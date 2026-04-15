# Agents.md — lobs-core Agent Runtime

## What is lobs-core?

lobs-core is Rafe's personal AI agent runtime — a TypeScript/Node.js Discord bot with an integrated agent orchestration engine. It runs as the **Lobs** coordinator agent and can spawn subagents (programmer, researcher, writer, reviewer, architect) for specialized tasks.

**Key capabilities:**
- Discord group chat integration with real-time message ingestion
- Subagent spawning via `Task` tool for parallel work
- Memory system with vector storage and SQLite persistence
- Cron-driven automation and health monitoring
- Code review, literature review, and research workflows

**Don't restart casually.** Only restart lobs-core (`lobs restart`) when a change genuinely requires it — not for every code edit. The system has a restart budget; unnecessary restarts waste capacity.

---

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Core application — agent loop, Discord client, tools, memory |
| `src/orchestrator/` | Control loop, scheduling, escalation, quality gates, worker management |
| `src/services/` | Business logic — code review, summarization, cron, Discord commands |
| `src/memory/` | Memory system — vector store, GC, reconciliation |
| `src/workers/` | Worker processes — autonomous lit review, etc. |
| `src/cli/` | CLI tools (`lobs` command, paw-task, paw-inbox, paw-status) |
| `src/runner/` | Subagent execution runtime |
| `src/skills/` | Reusable skill definitions |
| `docs/` | ADRs, design docs, group chat behavior spec |
| `scripts/` | Build, setup, and utility scripts |
| `tests/` | Vitest unit and integration tests |

---

## Build, Test, Lint

```bash
# Build TypeScript
npm run build

# Type check (run this before committing)
npm run typecheck

# Lint (ESLint with typescript-eslint)
npm run lint

# Run tests
npm test

# Development watch mode
npm run dev
```

**Pre-commit checklist:** `npm run typecheck && npm run lint`

---

## Important Conventions

### No Casual Restarts
The `lobs restart` command restarts the entire runtime. Only use it when a change genuinely requires a process reload. For most code changes, a rebuild (`npm run build`) is sufficient. The system has limited restart budget; be judicious.

### Subagent Patterns
Subagents are spawned via the `Task` tool with specific agent types:
- **programmer** — code implementation, fixes, refactoring
- **researcher** — information gathering, literature review
- **writer** — documentation, content creation
- **reviewer** — code review, feedback
- **architect** — design decisions, system planning

Subagents run independently and report back. Coordinate via memory/files, not shared state.

### Don't Re-implement — Delegate
If something exists (a script, service, tool), use it. Don't rewrite functionality that already works.

### SOUL.md Lives Outside the Repo
The agent personality profile (`SOUL.md`) lives at `~/.lobs/agents/main/`, not in the repository. Edits to it don't require git operations.

---

## Key Patterns

### Group Chat Coordination (NO_REPLY)
In Discord group chat, the agent operates as a **silent observer** by default — it reads everything but only responds when addressed or when a trigger threshold is crossed.

Use the `NO_REPLY` directive in code to suppress Discord responses when taking silent actions (e.g., running cron tasks, updating memory):

```typescript
// In silent/background operations
context.reply = 'NO_REPLY';  // Prevents Discord notification
```

See `docs/group-chat-agent-behavior.md` for the full behavioral spec.

### Subagent Spawning
Use the `Task` tool to spawn a subagent for a specific job:

```typescript
await Task.create({
  agent: 'programmer',
  goal: 'Refactor the memory GC to use batch operations',
  context: { /* relevant files, constraints */ }
});
```

Subagents write their output to memory and signal completion. The parent agent (Lobs) coordinates and reports back to Discord if needed.

### Health Monitoring
The orchestrator runs continuous health probes (disk, memory, CPU, session state). Check status with `lobs status`. If the system is degraded, check `lobs logs --tail 100` for the relevant service.

### Memory GC
Memory garbage collection runs automatically. The reconciler handles deduplication via title-based fallback. See `src/memory/gc.ts` for details.

---

## Working with lobs-core

1. **Read first** — Before editing any file, read it. Don't guess what's in it.
2. **Typecheck and lint** — Before considering work done: `npm run typecheck && npm run lint`
3. **Commit with context** — Use conventional commits (`feat:`, `fix:`, `docs:`, etc.) and write clear messages explaining WHY.
4. **Test what you build** — If tests exist, run them. Consider adding a test for non-trivial changes.
5. **Use the CLI** — `lobs status`, `lobs logs`, `lobs restart` are your friends. Don't manually kill processes.
6. **Respect boundaries** — Subagents are independent. Don't pass complex shared state; use memory/files for coordination.