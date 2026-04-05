# ADR: Self-Learning Loop Architecture

## Status: Proposed

## Date: 2026-04-05

## Authors: Rafe + Lobs

## Context

Investigating [Hermes Agent](https://github.com/NousResearch/hermes-agent) revealed a closed-loop self-improvement architecture where agents learn from experience and permanently improve. Hermes achieves this through agent-authored skills, mid-session memory nudges, session search, and security-gated persistence.

Lobs already has a strong memory foundation — a full reflection pipeline (event → clustering → LLM extraction → reconciliation → conflict resolution), embedding-based semantic search, confidence scoring, and evidence linking. What we lack is:

1. **Mid-session knowledge capture** — our reflection pipeline only runs post-session, meaning knowledge can be lost during long sessions or crashes
2. **Raw transcript recall** — memory_search finds extracted memories and indexed docs, but can't search the actual conversation ("what did we say about X last week?")
3. **Agent-authored tools** — the agent can use tools but never create, modify, or improve them

This ADR proposes three features that together form a self-learning loop: the agent works → knowledge is captured continuously → past sessions are searchable → the agent creates reusable tools → those tools make future work better.

## Decision

### Feature 1: Out-of-Band Session Knowledge Extraction

**Problem:** In-session nudging (Hermes's approach) pollutes the conversation, wastes tokens on meta-thinking, and distracts from the actual task.

**Solution:** A background `SessionWatcher` monitors the live session transcript and periodically runs knowledge extraction in a completely separate LLM call, without touching the live session.

**How it works:**

1. Register a hook on `after_llm_call` in `hooks.ts`
2. The `SessionWatcher` tracks turns since last extraction
3. When threshold is met (every ~15 turns, or when context usage > 60%):
   - Read the last N turns from the JSONL transcript (already written by `SessionTranscript`)
   - Send to a cheap model (Haiku) with a focused extraction prompt
   - Feed extracted candidates into the existing `reconcile()` pipeline
   - Memories land in DB with evidence chains, dedup, and conflict resolution
4. The live session never sees any of this — zero token overhead in the main conversation

**Extraction prompt focus areas:**
- Learnings: debugging insights, API quirks, architectural gotchas
- Decisions: tool preferences, architectural choices, configuration patterns
- Procedures: multi-step workflows the agent would want to repeat

**Budget controls:**
- Use Haiku (cheap) for extraction, separate from main session budget
- Cap at ~2K tokens per extraction run
- Minimum 5-minute cooldown between extractions
- Skip extraction if the last N turns are all tool I/O with no substantive reasoning

**Files affected:**
- New: `src/memory/session-watcher.ts`
- Modified: `src/runner/agent-loop.ts` (register hook on startup)
- Uses existing: `src/runner/hooks.ts`, `src/memory/reconciler.ts`, `src/runner/session-transcript.ts`

### Feature 2: Session Transcript Search in memory_search

**Problem:** memory_search finds extracted memories and indexed documents, but can't recall raw conversations. "What did we discuss about Docker networking?" might return a terse memory summary but not the actual exchange where the solution was worked out.

**Solution:** Add session transcript search as a third parallel source in the existing `memory_search` fan-out. The agent uses one tool; results are merged by score regardless of source.

**Schema:**

```sql
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  UNIQUE(session_id, turn, role)
);

CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content=session_messages,
  content_rowid=id
);
```

**Populate:** On session end, in `SessionTranscript.writeSummary()`, insert text content of each turn into `session_messages`. Strip tool call inputs/outputs (noise), keep only human-readable assistant text and user prompts.

**Search:** New function `searchSessionTranscripts(query, opts)` in `memory/search.ts`:
- FTS5 match against session_messages_fts
- Return matching messages with ±2 surrounding turns for context
- Score using same sigmoid normalization as structured memory search
- Apply 0.85x score discount (raw transcripts are lower signal than curated memories)

**Merge into memory_search:** In `memorySearchTool()`, add as third parallel search. Results tagged with `source: "session"`:
```
[3] session:abc123/turn-12 (score: 0.71, agent: main, 2026-04-02)
**Assistant:** The Docker networking issue was a DNS resolution problem...
```

**Retention:** 30-day TTL on session_messages rows. The reflection pipeline extracts important content into structured memories well before that. Markdown transcripts on disk stay 90 days (lobs-memory indexes those separately).

**Files affected:**
- Modified: `src/memory/search.ts` (new `searchSessionTranscripts` function)
- Modified: `src/runner/tools/memory.ts` (third fan-out source in `memorySearchTool`)
- Modified: `src/runner/session-transcript.ts` (populate session_messages on writeSummary)
- Modified: `src/db/schema.ts` or migration (new tables)

### Feature 3: Dynamic Tool Creation

**Problem:** The agent encounters complex multi-step tasks repeatedly but has no way to capture and reuse the procedure as a callable tool. Skills (markdown documents) are a half-measure — they require the agent to read and follow instructions manually. Real tools have defined parameters, validation, and execution.

**Solution:** The agent can create, register, and use new tools at runtime. Dynamic tools are stored on disk, loaded on session start, and hot-registered mid-session when created.

**Two tiers:**

**Tier 1 — Script tools:** The agent writes a shell script or TypeScript file plus a tool.json definition. When called, we execute the script with parameters as environment variables (`TOOL_{param_name}`).

```
~/.lobs/tools/{name}/
├── tool.json    # { name, description, input_schema }
└── run.sh       # executable script
```

**Tier 2 — Procedural tools:** For tasks too complex for a single script, the agent writes `steps.md`. When "called," the system returns the steps as instructions. The agent follows them with full context preloaded — like Hermes skills but integrated into the tool system.

```
~/.lobs/tools/{name}/
├── tool.json
└── steps.md     # structured procedure
```

**Tool management tool:** `tool_manage` with actions:
- `create`: Validate tool.json schema, write to disk, run security scan, hot-register
- `edit`: Update definition or implementation
- `delete`: Remove tool directory, unregister
- `list`: Return names + descriptions of all dynamic tools

**Security scanning before any write:**
- Block: command injection patterns (`rm -rf /`, `curl | bash`), credential exfiltration, system prompt injection
- Warn: potentially dangerous patterns (write to system paths, network access)
- Validate: tool names don't conflict with built-in tools, scripts are non-interactive
- Audit: log all dynamic tool creations

**Hot registration:** When the agent creates a tool mid-session, it's available on the **next LLM turn**. The agent loop's tool list reads from both the static `TOOL_REGISTRY` and the dynamic tool directory. `getToolDefinitions()` merges both sources.

**Self-improvement loop:**
- Track usage in `tool_usage` table (tool_name, session_id, timestamp, outcome)
- The out-of-band extractor (Feature 1) can note tool effectiveness
- Agent calls `tool_manage(action='edit')` to improve tools based on experience

**Files affected:**
- New: `src/runner/tools/dynamic.ts` (loader + executor for dynamic tools)
- New: `src/runner/tools/tool-manage.ts` (tool_manage tool definition + executor)
- New: `src/runner/tools/tool-security.ts` (security scanning)
- Modified: `src/runner/tools/index.ts` (merge dynamic tools into registry)
- Modified: `src/runner/types.ts` (add `tool_manage` to ToolName)
- Modified: `src/db/schema.ts` or migration (tool_usage table)

## Implementation Order

| Phase | Feature | Effort | Notes |
|-------|---------|--------|-------|
| 1 | Session search in memory_search | Small | Additive, low risk, immediate value |
| 2 | Out-of-band session extraction | Medium | Builds on hooks + reflection pipeline |
| 3 | Dynamic tool creation | Medium-Large | Most ambitious, most differentiated |

Phase 1 is largely plumbing — a new FTS5 table, populating it from existing transcripts, and adding a third search source. Low risk, high value.

Phase 2 leverages the hook system and reflection pipeline we already have. The main new code is the watcher logic and the extraction prompt.

Phase 3 is the most complex but also the most unique capability. No other agent framework lets the agent create real callable tools with security scanning and hot registration. This is where we pull ahead of Hermes.

## Success Criteria

- [ ] `memory_search("Docker networking issue")` returns relevant session transcript snippets alongside structured memories
- [ ] During a 50-turn session, the watcher extracts at least 2-3 memories without any in-session nudging
- [ ] Agent can create a script tool, use it in the same session, and it appears in the tool list
- [ ] Security scanner blocks a tool containing `curl | bash` or credential patterns
- [ ] Dynamic tools persist across sessions and are available to subagents

## What We're NOT Doing

- **Public skill marketplace** — our tools are deeply personalized
- **Separate user-modeling service** — our memory system already handles user preferences with evidence linking
- **In-session nudging** — explicitly rejected in favor of out-of-band extraction
- **Replacing our memory format** — Hermes's flat MEMORY.md/USER.md files are simpler than what we have; our DB-backed memory with confidence scoring is strictly better
