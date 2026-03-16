# Design Doc: Training Data Pipeline for Qwen3.5 9B Fine-Tuning

**Author:** Architect Agent  
**Date:** 2026-03-16  
**Status:** Proposed  
**Relates to:** `src/services/training-data.ts`, `src/api/training.ts`

---

## Problem Statement

Lobs has 8,000+ messages, 52MB of session transcripts, and 262 daily memory files — all representing "how Lobs should behave." None of this data feeds into fine-tuning today. The existing `TrainingDataService` only captures sentinel task outputs (1 example so far). We need an automated pipeline that:

1. Harvests training examples from all existing data sources
2. Scores them for quality
3. Presents them for human review
4. Exports them as JSONL for Unsloth QLoRA fine-tuning of Qwen3.5 9B

The first fine-tune targets: triage/routing, calendar analysis, system state analysis, response style, and memory summarization.

---

## Proposed Solution

A **Harvester Service** that runs as a background interval in the control-loop service registration (same pattern as `LearningService` extraction). It scans each data source, extracts conversation turns into the `training_data` table with deduplication and quality scores, and feeds the existing review/export API.

### Why extend, not replace

The existing `training-data.ts` and `training.ts` API are well-structured. The problem isn't the review/export flow — it's that nothing feeds it. We add harvesters that pour data into the same table with a richer schema.

---

## Architecture / Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                               │
├──────────────┬──────────────┬────────────┬──────────┬──────────┤
│ main_agent   │ chat         │ session    │ sentinel │ memory   │
│ _messages    │ _messages    │ transcripts│ outputs  │ files    │
│ (6473 rows)  │ (1553 rows)  │ (52MB JSONL│ (1 row)  │(262 .md) │
└──────┬───────┴──────┬───────┴─────┬──────┴────┬─────┴────┬─────┘
       │              │             │           │          │
       ▼              ▼             ▼           ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│              HARVESTER SERVICE (src/services/harvester.ts)       │
│                                                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐│
│  │ Conversation │ │ Session      │ │ Memory                   ││
│  │ Harvester    │ │ Harvester    │ │ Harvester                ││
│  │              │ │              │ │                          ││
│  │ main_agent + │ │ JSONL files  │ │ daily .md → summarize    ││
│  │ chat_messages│ │ → task/exec  │ │ pairs                    ││
│  └──────┬───────┘ └──────┬───────┘ └────────────┬─────────────┘│
│         │                │                      │              │
│         ▼                ▼                      ▼              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              QUALITY SCORER                                 ││
│  │  length check · turn count · tool usage · dedup hash       ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │                                   │
│                             ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              DEDUPLICATION                                  ││
│  │  content_hash (SHA-256 of normalized messages)              ││
│  └──────────────────────────┬──────────────────────────────────┘│
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              training_data TABLE (enhanced schema)               │
│                                                                 │
│  id · task_type · source · status · quality_score               │
│  messages_json · system_prompt · content_hash                   │
│  source_id · source_meta · harvest_batch · token_count          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
          ┌─────────────────┐   ┌─────────────────┐
          │ Review API      │   │ Export API       │
          │ (Nexus UI)      │   │ (JSONL → Unsloth)│
          │                 │   │                  │
          │ approve/reject  │   │ per task_type    │
          │ correct/flag    │   │ ChatML format    │
          └─────────────────┘   └─────────────────┘
```

---

## Data Flow

### 1. Harvest Cycle (every 6 hours, configurable)

```
START harvest cycle
│
├─► ConversationHarvester.run()
│   │
│   ├─ Query main_agent_messages WHERE created_at > last_harvest_watermark
│   │  GROUP BY channel_session_id
│   │
│   ├─ For each session window (sliding window of N turns):
│   │   ├─ Build ChatML conversation: system + user/assistant turns
│   │   ├─ Compute content_hash = SHA-256(normalized messages JSON)
│   │   ├─ Check: does content_hash already exist in training_data?
│   │   │   ├─ YES → skip
│   │   │   └─ NO  → score quality → INSERT with status='pending'
│   │   └─ Classify task_type via heuristic (see §Quality Scoring)
│   │
│   ├─ Query chat_messages JOIN chat_sessions WHERE created_at > watermark
│   │  Same sliding window logic
│   │
│   └─ Update harvest_watermarks.conversation = NOW()
│
├─► SessionHarvester.run()
│   │
│   ├─ Scan ~/.lobs/agents/*/sessions/*.jsonl
│   │  WHERE file mtime > last_harvest_watermark
│   │
│   ├─ For each JSONL file:
│   │   ├─ Parse lines → extract system prompt + user/assistant turns
│   │   ├─ Detect task_type from agent type + system prompt content
│   │   ├─ Extract "instruction → completion" pairs:
│   │   │   ├─ Full session → single long example (task execution)
│   │   │   └─ Interesting sub-conversations → shorter examples
│   │   ├─ Deduplicate by content_hash
│   │   └─ Score and INSERT
│   │
│   └─ Update harvest_watermarks.session = NOW()
│
├─► MemoryHarvester.run()
│   │
│   ├─ Scan ~/.lobs/agents/main/context/memory/*.md
│   │  WHERE file mtime > last_harvest_watermark
│   │
│   ├─ For each memory file:
│   │   ├─ Parse markdown sections (Events, Learnings, Decisions)
│   │   ├─ Build "summarize this conversation" training pairs:
│   │   │   system: "Extract learnings and decisions from this conversation."
│   │   │   user: [raw conversation context if available, or section content]
│   │   │   assistant: [the actual learning/decision text]
│   │   ├─ Deduplicate, score, INSERT
│   │
│   └─ Update harvest_watermarks.memory = NOW()
│
├─► SentinelHarvester.run()  (existing flow, unchanged)
│   │  Already logs via TrainingDataService.logExample()
│
└─► Update harvest_run_log
    Record: timestamp, counts per source, errors
```

### 2. Review Flow (existing, enhanced)

```
Nexus Dashboard → GET /api/training/pending?task_type=triage
                → Review example
                → POST /api/training/:id/approve   (status → approved)
                → POST /api/training/:id/correct   (edit messages, re-score)
                → POST /api/training/:id/reject    (status → rejected)
```

### 3. Export Flow (existing, enhanced)

```
GET /api/training/export?task_type=triage&status=approved&format=chatml
 │
 ├─ Query training_data WHERE task_type=? AND status=?
 ├─ For each row:
 │   ├─ Build ChatML conversation from messages_json
 │   ├─ Include system_prompt if present
 │   └─ Emit JSONL line: {"conversations": [{"from":"system","value":"..."},{"from":"human","value":"..."},{"from":"gpt","value":"..."}]}
 │
 └─ Return JSONL file (or stream)
```

---

## DB Schema Migration

### New table: `harvest_watermarks`

Tracks the high-water mark for each data source so we only process new data.

### Enhanced: `training_data` table

The existing table has: `id, task_type, input, output, model, status, created_at, reviewed_at, reviewer_notes`. We need to extend it significantly.

```sql
-- Migration: training_data_pipeline_v1

-- 1. New columns on training_data
ALTER TABLE training_data ADD COLUMN source TEXT NOT NULL DEFAULT 'sentinel';
  -- 'main_agent' | 'chat' | 'session_transcript' | 'sentinel' | 'memory' | 'manual'

ALTER TABLE training_data ADD COLUMN source_id TEXT;
  -- Foreign key hint: channel_session_id, chat session key, JSONL filename, etc.

ALTER TABLE training_data ADD COLUMN source_meta TEXT;
  -- JSON blob: { channelId, sessionKey, filename, lineRange, ... }

ALTER TABLE training_data ADD COLUMN messages_json TEXT;
  -- Full ChatML conversation as JSON array:
  -- [{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]
  -- This replaces/supplements the existing input/output columns for multi-turn examples.

ALTER TABLE training_data ADD COLUMN system_prompt TEXT;
  -- Extracted system prompt, stored separately for easy editing

ALTER TABLE training_data ADD COLUMN content_hash TEXT;
  -- SHA-256 of normalized messages_json, for deduplication

ALTER TABLE training_data ADD COLUMN quality_score REAL DEFAULT 0.0;
  -- 0.0–1.0 composite quality score (see §Quality Scoring)

ALTER TABLE training_data ADD COLUMN quality_flags TEXT;
  -- JSON: { "reasons": ["short_response", "has_tool_use", ...] }

ALTER TABLE training_data ADD COLUMN token_count INTEGER DEFAULT 0;
  -- Estimated token count for the full example (for export budgeting)

ALTER TABLE training_data ADD COLUMN turn_count INTEGER DEFAULT 0;
  -- Number of conversation turns

ALTER TABLE training_data ADD COLUMN harvest_batch TEXT;
  -- ISO timestamp of the harvest run that created this row

ALTER TABLE training_data ADD COLUMN corrected_messages_json TEXT;
  -- If reviewer corrects, store the corrected version here (original preserved)

-- 2. Indexes for dedup and filtering
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_data_content_hash
  ON training_data(content_hash);

CREATE INDEX IF NOT EXISTS idx_training_data_task_type_status
  ON training_data(task_type, status);

CREATE INDEX IF NOT EXISTS idx_training_data_source
  ON training_data(source);

CREATE INDEX IF NOT EXISTS idx_training_data_quality
  ON training_data(quality_score);

-- 3. Harvest watermarks table
CREATE TABLE IF NOT EXISTS harvest_watermarks (
  source TEXT PRIMARY KEY,
  last_harvested_at TEXT NOT NULL,
  last_source_id TEXT,
  rows_harvested INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Harvest run log
CREATE TABLE IF NOT EXISTS harvest_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  -- 'running' | 'completed' | 'failed'
  source_counts TEXT,
  -- JSON: { "main_agent": 42, "chat": 18, "session": 7, "memory": 3 }
  total_harvested INTEGER DEFAULT 0,
  total_duplicates INTEGER DEFAULT 0,
  error TEXT
);

-- 5. Backfill source='sentinel' for existing rows
UPDATE training_data SET source = 'sentinel' WHERE source IS NULL OR source = '';
```

### Drizzle Schema Additions

```typescript
// In src/db/schema.ts — add to training_data table definition:

export const trainingData = sqliteTable("training_data", {
  id: id(),
  taskType: text("task_type").notNull(),
  // --- existing ---
  input: text("input"),
  output: text("output"),
  model: text("model"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  reviewedAt: text("reviewed_at"),
  reviewerNotes: text("reviewer_notes"),
  // --- new ---
  source: text("source").notNull().default("sentinel"),
  sourceId: text("source_id"),
  sourceMeta: text("source_meta"),
  messagesJson: text("messages_json"),
  systemPrompt: text("system_prompt"),
  contentHash: text("content_hash"),
  qualityScore: real("quality_score").default(0),
  qualityFlags: text("quality_flags"),
  tokenCount: integer("token_count").default(0),
  turnCount: integer("turn_count").default(0),
  harvestBatch: text("harvest_batch"),
  correctedMessagesJson: text("corrected_messages_json"),
});

export const harvestWatermarks = sqliteTable("harvest_watermarks", {
  source: text("source").primaryKey(),
  lastHarvestedAt: text("last_harvested_at").notNull(),
  lastSourceId: text("last_source_id"),
  rowsHarvested: integer("rows_harvested").default(0),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const harvestRuns = sqliteTable("harvest_runs", {
  id: id(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull().default("running"),
  sourceCounts: text("source_counts"),
  totalHarvested: integer("total_harvested").default(0),
  totalDuplicates: integer("total_duplicates").default(0),
  error: text("error"),
});
```

---

## Quality Scoring Heuristics

Each example gets a `quality_score` from 0.0 to 1.0. The score is a weighted sum of binary/continuous signals.

### Scoring Signals

| Signal | Weight | Description | Computation |
|--------|--------|-------------|-------------|
| `response_length` | 0.15 | Responses should be substantive but not bloated | Parabolic: peaks at 100–500 chars, penalizes <20 or >3000 |
| `turn_completeness` | 0.15 | Full user→assistant exchange, not orphaned | 1.0 if ends with assistant turn, 0.3 otherwise |
| `no_error_markers` | 0.10 | No "I'm sorry, I can't", error messages, fallback text | 1.0 if clean, 0.0 if contains error/refusal patterns |
| `multi_turn_depth` | 0.10 | Multi-turn convos are more valuable | min(turn_count / 6, 1.0) |
| `has_tool_use` | 0.10 | Examples showing tool invocation are high-value for agent behavior | 1.0 if messages contain tool_calls, 0.0 otherwise |
| `style_match` | 0.15 | Matches Rafe's preferred style: direct, no filler | Score based on: low "I" usage, no "certainly/absolutely/I'd be happy to", short sentences |
| `task_specificity` | 0.15 | Can be clearly classified to a target task | 1.0 if task_type is high-confidence, 0.5 if ambiguous |
| `recency` | 0.10 | Newer examples reflect current behavior better | Linear decay: 1.0 for last 30 days, 0.5 at 90 days, 0.3 at 180+ |

### Composite Score

```
quality_score = Σ(signal_i × weight_i)
```

### Auto-Reject Thresholds

- `quality_score < 0.2` → auto-status `rejected` (obvious junk)
- `quality_score >= 0.7` → auto-status `auto_approved` (high confidence, still reviewable)
- `0.2 ≤ quality_score < 0.7` → status `pending` (needs human review)

### Quality Flags (stored in `quality_flags` JSON)

```json
{
  "reasons": ["short_response", "has_tool_use", "style_mismatch_filler"],
  "auto_decision": "pending",
  "signal_scores": {
    "response_length": 0.8,
    "turn_completeness": 1.0,
    "no_error_markers": 1.0,
    "multi_turn_depth": 0.5,
    "has_tool_use": 0.0,
    "style_match": 0.6,
    "task_specificity": 0.9,
    "recency": 1.0
  }
}
```

---

## Task Type Classification

Each training example must be tagged with a `task_type`. Classification is heuristic-first, LLM-assisted later.

### Heuristic Classifiers

```
task_type = classify(messages) based on:

"triage"          — user message is a request/question and assistant classifies or routes it
                    Signals: mentions of agents, task creation, "I'll have the programmer..."
                    Source priority: main_agent_messages (highest)

"calendar"        — messages reference calendar events, meetings, scheduling
                    Signals: "meeting", "calendar", "schedule", dates/times, Google Calendar context
                    Source priority: sentinel calendar_check outputs

"system_state"    — messages reference system metrics, disk, CPU, services
                    Signals: "disk", "CPU", "memory", "service", system monitoring context
                    Source priority: sentinel system_state outputs

"response_style"  — general conversation showing the target communication style
                    Signals: short exchanges, direct answers, no classification/routing behavior
                    Source priority: main_agent_messages, chat_messages

"summarization"   — condensing information into structured learnings/decisions
                    Signals: output contains "## Learnings", "## Decisions", structured markdown
                    Source priority: memory files

"task_execution"  — agent performs a multi-step task with tool use
                    Signals: tool_calls present, coding patterns, file operations
                    Source priority: session transcripts

"general"         — fallback for unclassified examples
```

### Classification Logic

```typescript
function classifyTaskType(messages: ChatMessage[], source: string): { type: string; confidence: number } {
  // 1. Source-based fast path
  if (source === 'sentinel:calendar_check') return { type: 'calendar', confidence: 0.95 };
  if (source === 'sentinel:system_state')   return { type: 'system_state', confidence: 0.95 };
  if (source === 'memory')                  return { type: 'summarization', confidence: 0.80 };

  // 2. Content-based classification
  const fullText = messages.map(m => m.content).join(' ').toLowerCase();

  if (hasTriageSignals(fullText))       return { type: 'triage', confidence: 0.70 };
  if (hasCalendarSignals(fullText))     return { type: 'calendar', confidence: 0.65 };
  if (hasSystemSignals(fullText))       return { type: 'system_state', confidence: 0.65 };
  if (hasToolUse(messages))             return { type: 'task_execution', confidence: 0.60 };
  if (hasSummarizationSignals(fullText)) return { type: 'summarization', confidence: 0.55 };

  // 3. Default: if short exchange with no special signals → response_style
  if (messages.length <= 4)             return { type: 'response_style', confidence: 0.50 };

  return { type: 'general', confidence: 0.30 };
}
```

---

## Harvester Strategies Per Source

### 1. ConversationHarvester (main_agent_messages + chat_messages)

**Schema mapping:**
- `main_agent_messages`: `(id, role, content, author, channel_id, token_estimate, created_at, channel_session_id)`
- `chat_messages`: `(id, session_key, role, content, model, tokens_used, tool_calls, created_at)`

**Windowing strategy:**

Conversations don't have clean boundaries in `main_agent_messages` — they're a continuous stream per channel. Strategy:

1. **Group by channel_session_id** (for main_agent) or **session_key** (for chat)
2. **Within each session, create sliding windows:**
   - Window size: 2–10 turns (1 turn = user + assistant pair)
   - Slide: 2 turns
   - This means a 10-turn conversation produces ~4 overlapping examples
3. **Prepend system prompt** from the session context (reconstructed)
4. **Each window is one training example**

Why overlapping windows: Short windows capture style. Long windows capture multi-turn reasoning. Overlap ensures coverage without explosion.

**Dedup:** Hash the concatenation of `role + content` for all messages in the window. Two windows with identical content (from different sessions) get deduplicated.

**Estimated yield:**
- 6473 main_agent messages ÷ ~4 msgs/turn ÷ 2 (overlap) ≈ **800 conversation examples**
- 1553 chat messages ÷ ~4 msgs/turn ÷ 2 ≈ **190 conversation examples**
- After dedup and quality filtering: **~600–700 usable examples**

### 2. SessionHarvester (JSONL transcripts)

**Format:** Each JSONL file is a full agent session — lines are `{role, content, tool_calls?, ...}`.

**Strategy:**
1. Parse each JSONL file into a message array
2. Extract the system prompt (first `system` role message)
3. Create one full-session example (for `task_execution` training)
4. Also extract "interesting sub-conversations":
   - User instruction → first assistant response (instruction following)
   - Tool call → tool result → assistant reasoning (tool use patterns)
5. Tag with agent type from the directory path (`programmer`, `architect`, etc.)

**Token budget concern:** Full programmer sessions can be huge (10K+ tokens). For QLoRA with Qwen3.5 9B, max sequence length is 8192 tokens practically. Strategy:
- Full sessions: truncate to first 6K tokens (captures task setup + initial execution)
- Sub-conversations: naturally shorter, usually fits

**Estimated yield:**
- ~967 session lines across all agent types
- After parsing: **~50–80 session examples** (many sessions are short)
- Sub-conversations: **~200–300 examples**

### 3. MemoryHarvester (daily .md files)

**Format:** Markdown with sections: Events, Learnings, Decisions, Findings, Notes.

**Strategy:**
1. Parse each daily memory file
2. Extract structured sections
3. Build training pairs:
   - For `summarization`: input = raw section content, output = structured summary
   - For `learning` extraction: simulate "given these events, what did we learn?"
4. Only files with substantive content (>200 chars of actual learnings/decisions)

**Estimated yield:**
- 262 memory files, maybe ~60% have substantive learnings
- **~150–200 summarization examples**

### 4. SentinelHarvester (existing)

No changes needed. The existing `TrainingDataService.logExample()` already captures these. Just needs the new columns populated.

**Estimated yield:** Grows over time. Currently 1. With pipeline running: **~10–30/week** depending on sentinel frequency.

---

## Training Task Priorities and Sample Count Targets

### Priority Order for First Fine-Tune

| Priority | Task Type | Why First | Min Examples | Target Examples | Current Estimate | Gap |
|----------|-----------|-----------|-------------|-----------------|------------------|-----|
| **P0** | `response_style` | Biggest behavior change, most data available | 200 | 500 | ~400 | Close |
| **P1** | `triage` | Core routing logic, high daily usage | 150 | 300 | ~100 | Need manual + synthetic |
| **P2** | `summarization` | Direct from memory files, clean signal | 100 | 200 | ~160 | Close |
| **P3** | `calendar` | Narrow task, sentinel provides clean examples | 50 | 100 | ~5 | Need synthetic + time |
| **P4** | `system_state` | Narrow task, sentinel provides clean examples | 50 | 100 | ~5 | Need synthetic + time |
| **P5** | `task_execution` | Complex, session transcripts noisy | 100 | 300 | ~80 | Ongoing harvest |

### Recommended Approach

**Phase 1 (Week 1–2): Harvest + Review**
- Run harvesters across all sources
- Human reviews ~200 examples to calibrate quality scoring
- Adjust quality thresholds based on review patterns

**Phase 2 (Week 3): First Fine-Tune — Response Style**
- Export `response_style` examples (should have 300+ by then)
- QLoRA fine-tune on Qwen3.5 9B via Unsloth
- Validate: does the model sound like Lobs should?

**Phase 3 (Week 4–5): Triage + Summarization**
- Supplement triage with ~100 manually crafted examples
- Export combined dataset: response_style + triage + summarization
- Second fine-tune pass

**Phase 4 (Ongoing): Calendar + System State**
- These accumulate naturally from sentinel runs
- Once 50+ examples each, add to the training mix

### Sample Count Rationale

For QLoRA on a 9B model:
- **200 examples** is the practical minimum for a narrow task to see behavioral shift
- **500 examples** gives reliable generalization for conversational style
- **1000+ examples** is where multi-task fine-tuning starts to shine
- Beyond **5000** you risk overfitting on QLoRA with typical r=16, alpha=32

The training mix should be **balanced by task type** to avoid catastrophic forgetting. For a combined dataset:
- 40% response_style (dominant behavior)
- 25% triage
- 15% summarization
- 10% calendar + system_state
- 10% task_execution

---

## Export Format

Unsloth expects ShareGPT/ChatML conversations format:

```jsonl
{"conversations": [{"from": "system", "value": "You are Lobs, a personal AI agent..."}, {"from": "human", "value": "what's on my calendar today?"}, {"from": "gpt", "value": "You have 3 meetings..."}]}
{"conversations": [{"from": "system", "value": "Classify this message..."}, {"from": "human", "value": "fix the login bug on paw-hub"}, {"from": "gpt", "value": "{\"agent\": \"programmer\", \"priority\": \"medium\", \"type\": \"task\"}"}]}
```

The export endpoint transforms `messages_json` (which uses OpenAI format internally) to ShareGPT format:
- `role: "system"` → `from: "system"`
- `role: "user"` → `from: "human"`
- `role: "assistant"` → `from: "gpt"`
- `role: "tool"` → omitted or inlined into prior assistant message

If `corrected_messages_json` exists, it takes precedence over `messages_json`.

---

## File Structure

```
src/
├── services/
│   ├── training-data.ts              # EXISTING — logExample(), getStats(), etc.
│   │                                 # MODIFY: add new columns to logExample()
│   │
│   ├── harvester/
│   │   ├── index.ts                  # HarvesterService — orchestrates all harvesters
│   │   │                             # Registers as interval in index.ts service start
│   │   │                             # Manages harvest_watermarks and harvest_runs
│   │   │
│   │   ├── conversation.ts           # ConversationHarvester
│   │   │                             # Reads main_agent_messages + chat_messages
│   │   │                             # Windowing, dedup, quality scoring
│   │   │
│   │   ├── session.ts                # SessionHarvester
│   │   │                             # Reads JSONL transcript files from disk
│   │   │                             # Full-session + sub-conversation extraction
│   │   │
│   │   ├── memory.ts                 # MemoryHarvester
│   │   │                             # Reads daily .md files
│   │   │                             # Extracts summarization training pairs
│   │   │
│   │   ├── quality.ts                # QualityScorer
│   │   │                             # Scoring signals, composite score
│   │   │                             # Style-match detection, error-marker detection
│   │   │
│   │   ├── classifier.ts             # TaskTypeClassifier
│   │   │                             # Heuristic task_type classification
│   │   │                             # Signal detection functions
│   │   │
│   │   └── util.ts                   # Shared utilities
│   │                                 # Content hashing, token estimation
│   │                                 # Message normalization, ChatML conversion
│   │
│   └── training-data.ts              # Enhanced with new schema support
│
├── api/
│   └── training.ts                   # EXISTING — MODIFY:
│                                     # Add ?task_type filter to all endpoints
│                                     # Add GET /api/training/harvest/status
│                                     # Add POST /api/training/harvest/run (manual trigger)
│                                     # Add GET /api/training/export with format param
│                                     # Add quality_score sorting to pending view
│
├── db/
│   ├── schema.ts                     # MODIFY: add new columns + tables
│   └── migrate.ts                    # MODIFY: add migration SQL
│
└── index.ts                          # MODIFY: register harvester interval
                                      # Same pattern as learningExtraction
```

---

## Integration Points

### 1. Service Registration (in `src/index.ts`)

Same pattern as the learning extraction pass:

```
start: () => {
  // ... existing startups ...

  // Training data harvester — every 6 hours
  const HARVEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const runHarvest = async () => {
    const { HarvesterService } = await import("./services/harvester/index.js");
    const svc = new HarvesterService();
    await svc.run();
  };
  // First run 2 minutes after startup
  const harvestStartup = setTimeout(runHarvest, 120_000);
  const harvestTimer = setInterval(runHarvest, HARVEST_INTERVAL_MS);
}
```

### 2. Training API Enhancements

New endpoints:
- `GET /api/training/harvest/status` — last run time, counts, watermark positions
- `POST /api/training/harvest/run` — trigger manual harvest (for testing/backfill)
- `GET /api/training/stats` — enhanced with per-task-type breakdowns
- `GET /api/training/export?task_type=X&min_quality=0.6&status=approved&format=chatml` — enhanced export

### 3. Nexus Dashboard

New UI sections (design only, implementation in nexus-dashboard repo):
- **Training Overview**: total examples by task_type, quality distribution chart
- **Review Queue**: filtered by task_type, sorted by quality_score desc
- **Harvest Status**: last run, watermarks, run history
- **Export Builder**: select task_types, quality threshold, preview count, download JSONL

---

## Trade-offs

| Decision | Upside | Downside |
|----------|--------|----------|
| Sliding window instead of session boundaries | More examples, captures style in short snippets | Some context loss, potential quality dilution |
| Heuristic classification (not LLM) | Fast, no LLM cost, deterministic | Less accurate, requires tuning thresholds |
| Quality auto-approve at 0.7+ | Reduces review burden | Some bad examples may slip through |
| SHA-256 dedup on content only | Simple, fast | Different system prompts with same conversation get deduped |
| Store messages in OpenAI format internally | Matches existing codebase conventions | Extra transform step on export |
| 6-hour harvest interval | Low overhead, sufficient freshness | New conversations take up to 6h to appear |
| Single training_data table (not per-task) | Simple queries, unified review flow | Table could grow large (10K+ rows) |

---

## Open Questions

1. **System prompt per task type:** Should we define canonical system prompts for each task_type, or extract them from the source data? Recommendation: define canonical ones and store in a `training_system_prompts` table. The harvester uses source system prompts as-is, but the export can override with canonical ones.

2. **Token counting accuracy:** Should we use a real tokenizer (tiktoken/Qwen tokenizer) or estimate? Recommendation: estimate at 4 chars/token for harvesting speed; use real tokenizer only at export time for final validation.

3. **LLM-assisted quality scoring:** Phase 2 enhancement — use the base Qwen3.5 9B to score examples before fine-tuning. Not needed for MVP but would improve quality gating. The local model is free to run.

4. **Synthetic data generation:** For low-volume tasks (calendar, system_state), should we generate synthetic examples? Recommendation: yes, but as a separate `source='synthetic'` pipeline. Not in scope for this design.

5. **Validation split:** Should the export include a train/val split? Recommendation: yes — 90/10 split, stratified by task_type. Export produces two files: `train.jsonl` and `val.jsonl`.

6. **Incremental fine-tuning:** After the first fine-tune, should subsequent runs include all data or only new? Recommendation: all data each time (QLoRA is fast enough). Accumulate, don't delta.

---

## Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Harvest crashes mid-run | Partial data, watermark not updated | Watermark only updates on success; idempotent re-run |
| Duplicate detection hash collision | Unlikely (SHA-256) | UNIQUE index prevents insert; log and skip |
| JSONL file corrupted | SessionHarvester fails for that file | Try/catch per file, log error, continue |
| DB grows too large | Slow queries | Periodic purge of rejected examples; index on quality_score |
| Quality scorer too aggressive | Good examples auto-rejected | Start conservative (low threshold), tune with human review |
| Quality scorer too permissive | Bad examples auto-approved | Human review catches these; adjust threshold based on rejection rate |
| Export produces inconsistent data | Bad fine-tune results | Validation split catches distribution issues; preview endpoint |

---

## Appendix: Existing Code Reference

### Current `training_data` columns (from `training-data.ts`)

```
id, task_type, input, output, model, status, created_at, reviewed_at, reviewer_notes
```

The existing `logExample()` method writes `input` (the prompt) and `output` (the completion). For multi-turn conversations, we need `messages_json` which stores the full conversation array. The `input`/`output` columns remain for backward compatibility with the sentinel single-turn format.

### Current `training.ts` API

```
GET  /api/training              → { total, pending, approved, rejected }
GET  /api/training/pending      → TrainingExample[]
POST /api/training/:id/approve  → { ok: true }
POST /api/training/:id/reject   → { ok: true }
POST /api/training/:id/correct  → { ok: true, corrected }
GET  /api/training/export       → JSONL stream
```

All existing endpoints continue to work. New functionality is additive.

### Channel Session Schema (from `main-agent.ts`)

```sql
channel_sessions (
  channel_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0
)
```

This is how we group `main_agent_messages` into conversations — join on `channel_session_id`.
