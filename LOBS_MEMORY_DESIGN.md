# Lobs Memory — Design Document

> Persistent, multi-agent memory system for the Lobs AI agent platform.

## 1. Problem Statement

Lobs agents need to **remember things** across sessions — decisions made, lessons learned, user preferences, project context, prior conversation insights. Today's system works but has structural issues:

1. **Dual backend confusion.** lobs-core has two memory search paths: a fast-but-dumb grep fallback and a rich in-process engine (BM25 + vectors + reranking + query expansion). The grep fallback exists because the in-process engine isn't always initialized at startup.

2. **Memory is flat files.** Daily memory files (`~/.lobs/agents/main/context/memory/YYYY-MM-DD.md`) accumulate entries. The condenser promotes learnings/decisions to `~/lobs-shared-memory/learnings.md` after 7 days, but there's no structured query, no conflict resolution, no evidence tracking.

3. **No multi-agent memory scoping.** All agents share the same flat memory files. A programmer subagent's findings mix with the main agent's decisions. There's no way to scope "what did the architect agent conclude about X?" vs "what did I decide about X?"

4. **No ground truth / derived separation.** Events (what happened) and conclusions (what we learned) live in the same format. There's no way to trace a learning back to the events that produced it, or to detect when a learning contradicts newer evidence.

## 2. Current Architecture

### 2.1 Storage

```
~/.lobs/agents/main/context/memory/
├── 2026-03-26.md          # Today's daily file
├── 2026-03-25.md          # Yesterday
├── ...older files...      # Condensed after 7 days
~/lobs-shared-memory/
├── learnings.md           # Permanent learnings/decisions (promoted from daily files)
```

**Daily file format:**
```markdown
# 2026-03-26 — Daily Memory

## Events

- **[14:30]** [event] — Rafe asked about memory system design
- **[14:35]** [learning] — lobs-memory server already implements the full search pipeline
- **[15:00]** [decision] — Will create persistent server to eliminate cold-start penalty
```

**Permanent file format:**
```markdown
- **[2026-03-20] [learning]** — Always lint code before considering a task done
- **[2026-03-21] [decision]** — Use standard tier for subagents by default
```

### 2.2 Search Pipeline (In-Process)

The full search pipeline lives in `lobs-core/src/services/memory/` (ported from `lobs-memory/server/`):

```
Query
  │
  ├─ Stage 1: Parallel BM25 (FTS5) + Vector search (sqlite-vec)
  │            Weighted merge (configurable text/vector weights)
  │
  ├─ Stage 2: Query expansion (optional, via LLM)
  │            Generates alternate queries → additional BM25/vector searches
  │
  ├─ Stage 3: Merge expansion results into candidate pool
  │
  ├─ Stage 4: Reranking (optional, via cross-encoder model)
  │            Re-scores candidates for relevance
  │
  └─ Stage 5: MMR (maximal marginal relevance) + temporal decay
              Diversifies results, penalizes stale content
```

**Key files:**
- `search.ts` — Full pipeline orchestration (616 lines in standalone, 504 in-process)
- `db.ts` — SQLite with FTS5 + sqlite-vec (vector embeddings stored alongside text)
- `embedder.ts` — LMStudio-backed embedding generation
- `reranker.ts` — Cross-encoder reranking (sidecar Python process or LMStudio)
- `expander.ts` — Query expansion via local LLM
- `indexer.ts` — File watching, chunking, and index maintenance
- `chunker.ts` — Markdown-aware document chunking
- `entities.ts` — Named entity extraction from chunks
- `graph.ts` — Entity relationship graph queries
- `parsers.ts` — File format parsers (markdown, code, etc.)

### 2.3 Context Engine

`lobs-core/src/runner/context-engine.ts` is the consumer. It:

1. **Classifies the task** (coding, debugging, architecture, research, etc.) using regex patterns + optional LLM fallback
2. **Allocates token budget** per category (memory, project, code, session, instructions) based on task type
3. **Searches lobs-memory** via batch queries scoped to different collections
4. **Categorizes results** (memory vs project vs code vs session) based on file paths
5. **Fills layers** up to budget, sorted by relevance score
6. **Formats** into a structured context block injected into the agent's prompt

### 2.4 Memory Client

`lobs-core/src/services/memory-client.ts` provides the unified API:

- `memorySearch(query, options)` — single search, in-process with grep fallback
- `memorySearchBatch(searches)` — parallel batch search
- `getHealth()` — service health check
- `triggerReindex()` — force re-index

The client tries in-process search first (`isMemoryReady()`) and falls back to grep when the memory service isn't initialized yet (early startup race).

### 2.5 Memory Condenser

`lobs-core/src/services/memory-condenser.ts` runs daily:

- Files ≤ 7 days old: untouched
- Files > 7 days old with > 30 entries: condensed
  - Keep `[learning]` and `[decision]` entries
  - Keep `[finding]` entries (but don't promote)
  - Drop `[event]` and `[note]` entries
  - Promote learnings/decisions to permanent file

### 2.6 Memory Write Tool

Agents write memory via `memory_write` tool:
- **Categories:** learning, decision, finding, event, note
- **Daily file:** Default target (events/notes always here)
- **Permanent file:** `permanent=true` for learning/decision/finding
- **Custom file:** `file` parameter override

## 3. Design Goals

### 3.1 Immutable Event Log + Derived Memories

**Ground truth:** Raw events are immutable. What happened, when, who was involved, what was said. These never change.

**Derived memories:** Learnings, decisions, and patterns are derived from events through reflection. They have:
- **Evidence links** — which events support this memory
- **Confidence scores** — how well-supported is this conclusion
- **Timestamps** — when derived, when last validated
- **Supersession** — newer memories can supersede older ones (with explicit links)

### 3.2 Agent-Scoped Memory

Memories are scoped at three levels:

| Scope | Visibility | Examples |
|-------|-----------|----------|
| **System** | All agents | User preferences, global config, project structure |
| **Agent** | Single agent type | "Programmer agents should always lint" |
| **Session** | Single run | Working memory for a specific task |

The main agent's decisions are system-level by default. Subagent findings are agent-scoped unless promoted.

### 3.3 Reflection with Evidence Thresholds

Reflection is the process of deriving structured memories from raw events. It must be:

- **Bounded** — reflection runs on a schedule, not on every event
- **Evidence-based** — a minimum number of supporting events required before a pattern becomes a memory
- **Conflict-aware** — when new evidence contradicts an existing memory, flag the conflict rather than silently overwriting
- **Auditable** — every derived memory traces back to its evidence

### 3.4 Search Quality Preservation

The existing search pipeline is good. The design preserves it entirely:
- BM25 + vector hybrid search
- Query expansion for recall
- Cross-encoder reranking for precision
- MMR for diversity
- Temporal decay for freshness

The only change is where it runs (always in-process, already done) and what it indexes (structured memories in addition to raw files).

## 4. Data Model

### 4.1 Events (Ground Truth)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,           -- ISO 8601
  agent_id TEXT NOT NULL,            -- 'main', 'programmer-abc123', etc.
  agent_type TEXT NOT NULL,          -- 'main', 'programmer', 'reviewer', etc.
  session_id TEXT,                   -- links events within a single agent run
  event_type TEXT NOT NULL,          -- 'observation', 'action', 'decision', 'error', 'user_input', 'tool_result'
  content TEXT NOT NULL,             -- what happened (human-readable)
  metadata TEXT,                     -- JSON: tool name, file paths, error codes, etc.
  scope TEXT NOT NULL DEFAULT 'session',  -- 'system', 'agent', 'session'
  project_id TEXT,                   -- optional project association
  signal_score REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0, event importance for indexing (§7.1)
  
  -- Indexing
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_agent ON events(agent_id, timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_project ON events(project_id);
CREATE INDEX idx_events_signal ON events(signal_score) WHERE signal_score > 0.5;
```

### 4.2 Memories (Derived)

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL,         -- 'learning', 'decision', 'pattern', 'preference', 'fact'
  content TEXT NOT NULL,             -- the memory itself
  confidence REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0, based on evidence strength
  scope TEXT NOT NULL DEFAULT 'system',  -- 'system', 'agent', 'session'
  agent_type TEXT,                   -- which agent type this applies to (null = all)
  project_id TEXT,                   -- optional project scope
  
  -- Authority (determines conflict resolution priority)
  source_authority INTEGER NOT NULL DEFAULT 1,
  -- 3 = user (Rafe said it directly)
  -- 2 = system/verified outcome (observed result of an action)
  -- 1 = agent inference (agent concluded this)
  -- 0 = reflection-derived (auto-extracted from event patterns)
  
  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'stale', 'superseded', 'contested', 'archived'
  superseded_by INTEGER,             -- FK to newer memory that replaces this one
  
  -- Timestamps
  derived_at TEXT NOT NULL,          -- when this memory was created
  last_validated TEXT,               -- when last confirmed by new evidence
  expires_at TEXT,                   -- optional TTL (e.g., session-scoped memories)
  
  -- Access tracking (for dead memory detection + usage-based prioritization)
  last_accessed TEXT,                -- last time this memory was retrieved in a search
  access_count INTEGER NOT NULL DEFAULT 0,  -- total retrieval count
  
  -- Traceability
  reflection_run_id TEXT,             -- links to the reflection run that created this memory
  
  -- Note: embeddings stored in separate memory_embeddings table (§4.2.1)
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_memories_type ON memories(memory_type, status);
CREATE INDEX idx_memories_scope ON memories(scope, agent_type);
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_access ON memories(last_accessed);  -- for dead memory queries
```

### 4.2.1 Memory Embeddings (Separate Table)

Embeddings are stored separately from the main memories table to keep scans fast and make it trivial to swap vector backends later.

```sql
CREATE TABLE memory_embeddings (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id),
  embedding BLOB NOT NULL           -- vector embedding for semantic search
);
```

The `memories` table has no `embedding` column — all vector operations go through `memory_embeddings`. This keeps the main table small and scannable.

### 4.3 Evidence Links

```sql
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  relationship TEXT NOT NULL,        -- 'supports', 'contradicts', 'context'
  strength REAL NOT NULL DEFAULT 1.0, -- how strongly this event supports/contradicts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_memory ON evidence(memory_id);
CREATE INDEX idx_evidence_event ON evidence(event_id);
```

### 4.4 Memory Conflicts

```sql
CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_a INTEGER NOT NULL REFERENCES memories(id),
  memory_b INTEGER NOT NULL REFERENCES memories(id),
  description TEXT NOT NULL,         -- what the conflict is
  resolution TEXT,                   -- how it was resolved (null = unresolved)
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.5 Reflection Runs (Traceability)

```sql
CREATE TABLE reflection_runs (
  id TEXT PRIMARY KEY,               -- UUID
  trigger TEXT NOT NULL,             -- 'session_end', 'daily', 'manual'
  started_at TEXT NOT NULL,
  completed_at TEXT,
  clusters_processed INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,
  memories_reinforced INTEGER DEFAULT 0,
  conflicts_detected INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'local', -- 'local' or 'escalation'
  status TEXT NOT NULL DEFAULT 'running' -- 'running', 'completed', 'failed', 'skipped'
);
```

### 4.6 Retrieval Log (Optional, for Tuning)

```sql
CREATE TABLE retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  query TEXT NOT NULL,               -- the search query that surfaced this memory
  agent_id TEXT,
  score REAL,                        -- relevance score at retrieval time
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_retrieval_memory ON retrieval_log(memory_id);
CREATE INDEX idx_retrieval_time ON retrieval_log(timestamp);
```

This enables:
- Debugging relevance (why did this memory surface for that query?)
- Identifying useless memories (surfaced often but low score)
- Tuning search scoring (which memories consistently rank high but aren't useful?)

## 5. Reflection Pipeline

Reflection transforms raw events into structured memories. It runs on a schedule (not real-time) and follows strict rules.

### 5.1 Trigger Conditions

| Trigger | Frequency | Scope |
|---------|-----------|-------|
| Session end | After each agent run completes | Session events |
| Daily condensation | Once per day (existing condenser schedule) | All events from past day |
| Manual | On-demand via tool or CLI | Specified event range |

#### Skip Conditions

Reflection is skipped entirely if:
- Total events in scope < 10 (not enough signal)
- No high-signal events (`signal_score > 0.7`) present
- No errors, decisions, user directives, or corrections in the session
- Daily reflection budget exhausted (`maxDailyRuns` reached)

This prevents burning reflection tokens on routine sessions (e.g., simple file reads, status checks).

#### Reflection Budget

| Limit | Value | Scope |
|-------|-------|-------|
| Max tokens per session | 2k–4k | Per reflection run |
| Max candidates per cluster | 5 | Per episode |
| Max daily reflection runs | 50 (configurable) | Global |

### 5.2 Episode Clustering (Deterministic v1)

Clustering is where reflection systems silently fail. We start with deterministic rules — no LLM clustering.

**Grouping rules (applied in order):**

1. **Same `session_id`** → always same cluster
2. **Same `project_id` AND time gap < 10 minutes** → same cluster
3. **Strong entity overlap (≥2 shared entities)** → merge clusters

**Split rules:**

1. **Time gap > 30 minutes** → force split (even within session)
2. **New `user_input` event after a gap > 5 minutes** → new cluster (likely new intent)

LLM-based topic detection is explicitly deferred to a later version. It would add cost, instability, and inconsistent grouping. Rule-based clustering is good enough for v1 and produces reproducible results.

### 5.3 Reflection Process

```
0. Check skip conditions — abort if not worth reflecting (§5.1)
1. Generate reflection_run_id (UUID) for traceability
2. Gather unreflected events (events not yet linked to any memory)
3. Cluster events using deterministic rules (§5.2)
4. Prioritize clusters by value:
   - Contains errors → high priority
   - Contains decisions or user corrections → high priority
   - Contains repeated tool failures → high priority
   - Long session (> 50 events) → medium priority
   - Routine activity only → skip (unless over daily event threshold)
5. For each cluster (highest priority first, within budget):
   a. Tier 1 (default, local model): Extract candidate memories
   b. Tier 2 (rare, escalation model): Only if conflicts detected,
      repeated failures across episodes, or unclear resolution
   c. Dedup against existing memories:
      - If similarity(existing, candidate) > 0.9 → reinforce existing (bump confidence, add evidence)
      - If contradicting → create conflict record, apply auto-resolution rules (§8.3.1)
      - If novel AND evidence threshold met → create new memory
   d. Enforce per-episode limit: max 5 new memories per cluster
6. Enforce daily limit: max N memories per day (configurable, default 50)
7. Tag all new memories with reflection_run_id
8. Update memory confidence scores
9. Update access tracking on all memories surfaced during reflection
10. Mark events as reflected
11. Log reflection run metadata (run_id, clusters processed, memories created, tokens used)
```

### 5.4 Evidence Thresholds

| Memory Type | Min Events | Min Confidence | Notes |
|------------|-----------|----------------|-------|
| Learning | 2 | 0.6 | Need at least 2 corroborating events |
| Decision | 1 | 0.8 | Explicit decisions have high confidence immediately |
| Pattern | 3 | 0.5 | Patterns need more evidence to establish |
| Preference | 2 | 0.7 | User preferences escalate quickly |
| Fact | 1 | 0.9 | Facts are high-confidence, low-evidence |

### 5.5 Confidence Decay

Memories that aren't reinforced by new evidence decay slowly:

```
confidence(t) = base_confidence * (0.5 ^ (days_since_last_validation / half_life))
```

- **Decisions:** half_life = 365 days (slow decay — decisions are sticky)
- **Learnings:** half_life = 180 days
- **Patterns:** half_life = 90 days (need regular reinforcement)
- **Preferences:** half_life = 365 days (preferences are sticky)
- **Facts:** no decay (facts don't expire)

## 6. Search Integration

### 6.1 Two-Tier Query Pipeline

Not every query needs the full pipeline. We define explicit fast and slow paths.

#### Fast Path (default, target: <200ms)

```
Query → Structured memory FTS5 lookup + recent session events → Return
```

- Direct FTS5 on `memories` table (active status only)
- Recent session events (last 24h)
- No reranker, no query expansion, no vector search
- Used for: "what did I decide about X?", preference lookups, recent context

#### Slow Path (triggered, target: <2s)

```
Query → Full pipeline (BM25 + vector + expansion + reranking + graph) → Return
```

- Full document + memory search with all stages
- Used for: ambiguous queries, large tasks, failure recovery, "what happened before"

**Slow path triggers:**
- Query is ambiguous (low top-1 confidence on fast path, < 0.6)
- Explicit request ("search deeply", "what happened before")
- Task classifier returns `research`, `debugging`, or `architecture`
- Fast path returns < 2 results

### 6.2 Unified Search (Slow Path)

Memory search queries both the existing document index AND the structured memories table. Results merge and rank together.

```
Query
  │
  ├─ Document search (existing pipeline) → file-based results
  │
  ├─ Memory search (new) → structured memory results
  │    ├─ FTS5 on memories.content
  │    └─ Vector search on memory_embeddings.embedding
  │
  └─ Merge + re-rank all candidates together
```

### 6.3 Memory-Aware Scoring

Structured memories get scoring bonuses:
- **Active memories:** +0.1 score boost (they're curated knowledge)
- **High confidence:** scaled boost up to +0.15 for confidence > 0.8
- **Scope match:** +0.1 if memory scope matches the querying agent's scope
- **Access frequency:** minor boost for frequently-accessed memories (log-scaled `access_count`)
- **Recency:** existing temporal decay applies

Contested or superseded memories are demoted but not hidden (they provide context).

**On retrieval:** Update `last_accessed` and increment `access_count` for every memory returned in search results. This is how we detect dead memory and prioritize useful memory.

### 6.4 Context Engine Integration

The context engine changes are **not minimal** — they affect memory format, semantics, and importance signaling.

**New memory result category:**
1. Add `"structured-memory"` to `categorizeResult()`, mapped to the `memory` budget allocation
2. Structured memories get distinct formatting in context blocks:

```
[Memory: learning | confidence: 0.85 | evidence: 4 | last validated: 2026-03-20]
Always lint code before considering a task done.

[Memory: pattern | confidence: 0.62 | evidence: 3 | contested]
Subagents perform better with explicit file path lists than directory references.
```

3. This formatting is critical — it tells the model how much to trust each memory. A confidence-0.9 fact with 5 evidence links should be treated very differently from a confidence-0.5 pattern with 2.

4. Add a `memories` collection to the batch search queries

## 7. Write Path

### 7.1 Event Recording

Events are recorded automatically by the agent runner with signal-based filtering.

#### Signal Classification

Every event gets a `signal_score` (0.0–1.0) at ingestion time:

| Event Type | Signal Score | Notes |
|-----------|-------------|-------|
| `user_input` | 1.0 | Always significant |
| `error` | 0.9 | Failures are important |
| `decision` | 0.9 | Explicit decisions |
| `observation` | 0.7 | Agent noticed something |
| `tool_result` (meaningful) | 0.7 | Search results, file reads with key info |
| `tool_result` (routine) | 0.3 | Generic ls, status checks |
| `action` (file write) | 0.6 | Code/content changes |
| `action` (navigation) | 0.2 | cd, ls, pwd |
| streaming tokens | 0.0 | Never stored |

#### Storage vs Indexing

- **All events are stored** in the `events` table (ground truth is complete)
- **Only events with `signal_score > 0.5` are indexed** for search (FTS5 + embeddings)
- This keeps the search index focused on meaningful content while preserving full audit trail

(`signal_score` column and partial index defined in the events schema, §4.1)

This replaces the current `memory_write` tool for event-level data. The tool remains for explicit memory creation (agent deliberately writes a learning).

### 7.2 Memory Write Tool (Updated)

The `memory_write` tool gets a new mode:

```typescript
// Existing: write to daily file (backward compatible)
memory_write({ content: "...", category: "event" })

// New: create structured memory directly
memory_write({ 
  content: "Always check git status before starting work",
  category: "learning",
  permanent: true,
  evidence: ["session-abc123"]  // optional: link to events
})
```

When `permanent=true`, the tool creates a row in the `memories` table instead of (or in addition to) appending to the flat file.

### 7.3 Migration Path

Phase 1 (backward compatible):
- Keep flat file writes working exactly as today
- Add event recording alongside flat file writes
- New structured memories are written to both DB and flat file

Phase 2 (structured primary):
- Flat files become a read-only archive
- All new memories go to structured DB
- Search queries both sources

Phase 3 (flat files deprecated):
- Flat files are generated from DB for human readability
- DB is the source of truth
- Condenser operates on DB instead of flat files

## 8. Multi-Agent Coordination

### 8.1 Agent Identity

Each agent run gets a unique `agent_id` (e.g., `programmer-abc123`) and a known `agent_type` (e.g., `programmer`). The main agent is always `main`.

### 8.2 Memory Promotion

Subagent memories start at `session` scope. They can be promoted:

```
session → agent → system
```

**Automatic promotion:**
- If the main agent explicitly references a subagent finding, it's promoted to system scope
- If a subagent creates a `decision` with confidence > 0.8, it's promoted to agent scope

**Manual promotion:**
- Main agent can promote any memory: `memory_write({ promote: "memory-123", scope: "system" })`

### 8.3 Conflict Resolution

When agents produce conflicting memories:

1. Both memories are kept with `status: 'contested'`
2. A conflict record is created
3. Auto-resolution rules are applied (§8.3.1)
4. If not auto-resolved, the conflict surfaces in the main agent's context on next run
5. Main agent resolves by:
   - Choosing one (supersedes the other)
   - Merging into a new memory
   - Dismissing both

Rafe can also resolve conflicts through explicit instruction.

#### 8.3.1 Auto-Resolution Rules

Most conflicts can be resolved without human intervention using the `source_authority` field:

| Case | Rule | Example |
|------|------|---------|
| Same scope + newer + same or higher authority | Supersede old | Agent updates its own earlier inference |
| User preference update (authority=3) | Always supersede | Rafe says "actually I prefer X" |
| Higher authority contradicts lower | Supersede lower | Verified outcome overrides agent inference |
| Same authority + low confidence (<0.5) | Mark disputed, don't replace | Two weak inferences disagree |
| Same authority + high confidence (>0.7) | Escalate to main agent | Two strong inferences disagree — needs judgment |

**Authority hierarchy:**
```
3 = user         (Rafe said it directly → near-absolute trust)
2 = system       (verified outcome, observed result)
1 = agent        (agent inference, explicit agent conclusion)
0 = reflection   (auto-extracted from event patterns → lowest trust)
```

Auto-resolution is logged in the `conflicts` table with `resolution = 'auto: [rule applied]'`.

### 8.4 Memory Garbage Collection (Lifecycle)

GC is a deterministic state machine, not a policy. Every memory follows: `active → stale → archived`.

#### 8.4.1 State Transitions

**Case 1: Never used**
```
access_count = 0 AND age > 90 days → stale
stale for 30 days (no retrieval) → archived
```

**Case 2: Used but abandoned**
```
last_accessed > 180 days ago → stale
stale for 60 days (no retrieval) → archived
```

**Case 3: Reinforced but never retrieved**

A memory that keeps getting new evidence but is never actually retrieved is *true but irrelevant*.
```
evidence_count growing AND access_count < 3 over 90 days → reduce confidence gradually
  confidence *= 0.95 per 30-day cycle (not archived, just deprioritized)
```

#### 8.4.2 Safety Rules (Never Auto-Archive)

Some memories must survive indefinitely unless explicitly superseded:

| Condition | Rule |
|-----------|------|
| `source_authority >= 2` | Never auto-archive (user preferences, verified outcomes) |
| `evidence_count >= 5` | Never auto-archive (well-supported) |
| `memory_type = 'preference'` | Never auto-archive (user prefs live forever) |
| `memory_type = 'decision'` AND `confidence > 0.7` | Never auto-archive |

These can only be removed via explicit supersession or user instruction.

#### 8.4.3 What "Archive" Means

Archiving is **not** a status flag change. It's a cold-tier transition:

```sql
-- 1. Move to archived status
UPDATE memories SET status = 'archived', updated_at = datetime('now')
WHERE id IN (...);

-- 2. Remove from search index (embeddings)
DELETE FROM memory_embeddings WHERE memory_id IN (...);

-- 3. Memory row stays in DB (never deleted)
```

Archived memories:
- **NOT returned** in normal fast-path or slow-path queries
- **Only returned** if: explicit historical query, debugging memory system, or `include_archived=true` flag
- Remain in DB for audit trail and potential resurrection

#### 8.4.4 Resurrection

If an archived memory becomes relevant again (e.g., slow-path historical query surfaces it and it's useful):

```sql
UPDATE memories SET status = 'active', last_accessed = datetime('now')
WHERE id = ?;
-- Re-generate embedding
INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?);
```

#### 8.4.5 GC Schedule

GC runs daily alongside the existing condenser. The full check:

```
1. Identify stale candidates (Case 1 + Case 2 conditions)
2. Apply safety rules — exclude protected memories
3. Transition qualifying active → stale
4. Transition qualifying stale → archived (with embedding cleanup)
5. Apply Case 3 confidence reduction
6. Log all transitions for audit
```

#### 8.4.6 Importance Decay from Access

In addition to confidence decay (§5.5), memories have access-based importance decay:

```
importance(t) = base_importance * (0.5 ^ (days_since_last_accessed / access_half_life))
```

- `access_half_life` = 120 days (memories unused for 4 months are half as important)
- This affects **search ranking only**, not GC transitions
- Memories with high `access_count` get a log-scaled floor: `max(importance(t), 0.1 * log2(access_count + 1))`

This ensures unused memory drops in search ranking before it hits the GC threshold.

## 9. Implementation Plan

### Phase 1: Schema + Event Recording

**Goal:** Get data flowing into structured tables.

1. Create all tables: `events` (with `signal_score`), `memories` (with access tracking + `reflection_run_id`), `memory_embeddings`, `evidence`, `conflicts`, `reflection_runs`, `retrieval_log`
2. Create `EventRecorder` service — hook into agent runner
3. Implement signal classification at ingestion
4. Keep flat file writes working alongside (backward compatible)

**No new behavior visible.** Just starts recording structured events.

### Phase 2: Extraction + Reconciliation

**Goal:** Create structured memories from events.

1. Implement memory extraction (simple, strict — local model only)
2. Key-based reconciliation: dedup against existing memories (0.9 similarity threshold)
3. Evidence linking: connect memories to supporting events
4. `memory_write` tool gains structured mode (`permanent: true` → DB row)

**Critical quality gate:** Extraction quality determines system quality. Get this right before moving on.

### Phase 3: Fast-Path Query

**Goal:** Memories are searchable.

1. FTS5 on `memories.content` (fast path only, no reranker yet)
2. Access tracking middleware: update `last_accessed` + `access_count` on every retrieval
3. Retrieval logging (optional, `retrieval_log` table)
4. Context engine integration: structured memory formatting in agent context
5. Scope filtering: system/agent/session visibility rules

### Phase 4: Session-End Reflection

**Goal:** Automated memory creation.

1. Reflection pipeline runs on session end only (not daily yet)
2. Skip conditions enforced (§5.1)
3. Deterministic clustering (§5.2)
4. Tier 1 only (local model)
5. Budget enforcement (per-episode + daily limits)
6. `reflection_runs` table populated for traceability

### Phase 5: GC + Lifecycle

**Goal:** Memory doesn't grow unbounded.

1. GC state machine: active → stale → archived (§8.4)
2. Safety rules enforced (never auto-archive protected memories)
3. Embedding cleanup on archive
4. Importance decay from access (§8.4.6)
5. Daily GC runs alongside condenser

### Phase 6: Full Pipeline + Deprecation

**Goal:** Slow-path search, daily reflection, flat file deprecation.

1. Slow-path: full BM25 + vector + reranking pipeline on memories
2. Daily reflection (condensation replacement)
3. Conflict resolution: auto-resolution rules + escalation
4. Agent memory promotion logic
5. Generate flat files from DB (read-only view layer)
6. CLI: `lobs memory list`, `lobs memory promote`, `lobs memory conflicts`

### Explicitly Deferred

**Do NOT build yet:**
- Entity relationship graph
- Complex LLM-based clustering
- Full conflict resolution UI
- Cross-room memory sharing

## 10. Configuration

Extends the existing memory config (`~/.lobs/config/memory.json`):

```json
{
  "lmstudio": {
    "baseUrl": "http://127.0.0.1:1234",
    "embeddingModel": "text-embedding-nomic-embed-text-v1.5",
    "chatModel": "qwen2.5-1.5b-instruct-mlx"
  },
  "reranker": {
    "mode": "sidecar"
  },
  "search": {
    "vectorWeight": 0.4,
    "textWeight": 0.6,
    "candidateMultiplier": 3,
    "maxResults": 10,
    "mmr": { "enabled": true, "lambda": 0.7 },
    "temporalDecay": { "enabled": true, "halfLifeDays": 90 },
    "reranking": { "enabled": true, "candidateCount": 20 },
    "queryExpansion": { "enabled": true, "strongSignalThreshold": 5.0 }
  },
  "reflection": {
    "enabled": true,
    "onSessionEnd": true,
    "dailyCondensation": true,
    "evidenceThresholds": {
      "learning": { "minEvents": 2, "minConfidence": 0.6 },
      "decision": { "minEvents": 1, "minConfidence": 0.8 },
      "pattern": { "minEvents": 3, "minConfidence": 0.5 }
    },
    "confidenceDecay": {
      "learning": 180,
      "decision": 365,
      "pattern": 90,
      "preference": 365
    },
    "limits": {
      "maxPerEpisode": 5,
      "maxPerDay": 50,
      "dedupThreshold": 0.9,
      "maxTokensPerSession": 4000,
      "maxCandidatesPerCluster": 5,
      "maxDailyRuns": 50
    },
    "skipConditions": {
      "minEventsForReflection": 10,
      "requiresHighSignal": true
    },
    "tiers": {
      "default": "local",
      "localModel": "qwen2.5-1.5b-instruct-mlx",
      "escalationModel": "anthropic/claude-sonnet",
      "escalationTriggers": ["conflict", "repeated_failures", "unclear_resolution"]
    }
  },
  "collections": [
    { "name": "workspace", "path": "~/.lobs/agents", "pattern": "**/*.md" },
    { "name": "knowledge", "path": "~/lobs-shared-memory", "pattern": "**/*.md" },
    { "name": "projects", "path": "~/lobs", "pattern": ["**/README.md", "**/DESIGN.md", "**/docs/**/*.md"] }
  ]
}
```

## 11. Open Questions

1. ~~**Event volume.**~~ *Resolved:* Signal scoring at ingestion (§7.1). All events stored, only high-signal events indexed for search.

2. ~~**Reflection LLM cost.**~~ *Resolved:* Two-tier reflection (§5.3) with budget controls (§5.1). Tier 1 uses local qwen2.5-1.5b (free). Tier 2 escalates to stronger model only for conflicts/repeated failures. Hard limits: 4k tokens/session, 50 runs/day, skip conditions prevent reflecting on low-value sessions.

3. **Embedding storage overhead.** Each memory gets a vector embedding stored in `memory_embeddings`.

   *Proposed:* Use the same embedding model already in use (nomic-embed-text-v1.5, 768 dimensions = ~3KB per memory). At 10K memories, that's ~30MB — negligible. Separate table (§4.2.1) keeps the main table fast.

4. **Concurrent agent writes.** Multiple subagents might try to record events simultaneously.

   *Proposed:* SQLite's WAL mode handles concurrent reads well but serializes writes. For the expected concurrency (2-4 agents max), this is fine. If it becomes a bottleneck, batch writes through a queue.

5. ~~**Dead memory garbage collection.**~~ *Resolved:* Full GC lifecycle defined in §8.4 — deterministic state machine (active → stale → archived), safety rules for high-authority memories, cold tier with embedding cleanup.

## 12. Success Metrics

- **Search quality:** Memory search returns relevant results within top-3 for known queries (manual eval)
- **Cold start:** Zero. Memory service starts with lobs-core, no separate process needed.
- **Reflection accuracy:** >80% of auto-derived memories are useful when reviewed manually
- **Conflict detection:** Contradicting memories are flagged within 24 hours
- **Agent context quality:** Context engine assembles more relevant context (measured by agent task success rate)
