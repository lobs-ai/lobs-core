# ADR: Bifurcated Memory Compliance System

**Status**: Accepted  
**Date**: 2026-03-06  
**Author**: Architect agent

---

## Problem Statement

PAW agents store memory files in `~/.lobs/workspace-{agent}/memory/`. These files may contain summaries of sensitive data — FERPA student records, HIPAA health information, or other compliance-restricted content. When an agent is spawned on a cloud AI session (Anthropic, OpenAI, etc.), lobs core auto-injects these memory files into the system prompt, potentially leaking sensitive data to third-party cloud providers.

The existing compliance system enforces local-model-only execution for tasks and projects with `compliance_required=true`, but this only prevents sensitive **task prompts** from going to cloud AI. It does **not** protect sensitive **memories** from being injected during cloud sessions.

---

## Solution

### Core Principle: Directory Separation as Primary Enforcement

Two memory directories per agent workspace:

```
~/.lobs/workspace-{agent}/
  memory/             ← non-compliant (cloud-safe), auto-injected by lobs core
  memory-compliant/   ← compliant (local-only), NOT scanned by lobs core
```

lobs core only scans `memory/`, so compliant memories are structurally isolated — they **cannot** reach cloud AI through the core injection path.

The plugin's `before_prompt_build` hook explicitly reads `memory-compliant/` files and appends them to the prompt **only when the session is in compliance mode** (i.e., the task or project has `compliance_required=true`).

**Why directory separation over frontmatter-only enforcement:**

Frontmatter tagging is useful metadata but cannot be relied upon for enforcement — it's too easy for an agent to create a file in `memory/` and forget the tag. Directory separation makes the enforcement structural and impossible to accidentally bypass.

### Frontmatter Tagging (Metadata + Validation Layer)

Memory files optionally support YAML frontmatter:

```yaml
---
compliance_required: true
tags: [ferpa, student-data]
---
# Memory content here
```

Frontmatter enables:
1. **Anomaly detection**: files in `memory/` tagged `compliance_required: true` are flagged as misplaced
2. **Compliance reporting**: the `memory_compliance_index` table is populated from both directory location and frontmatter
3. **Migration tooling**: scanner can detect and move misplaced files

Files without frontmatter are treated as non-compliant (safe default).

### DB Table: `memory_compliance_index`

Tracks compliance metadata for all memory files across agent workspaces. Enables compliance reports without scanning the filesystem on every request.

```sql
CREATE TABLE memory_compliance_index (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  file_path TEXT NOT NULL,      -- absolute path
  filename TEXT NOT NULL,
  directory TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'memory-compliant'
  compliance_required INTEGER NOT NULL DEFAULT 0,  -- derived: 1 if in memory-compliant/ OR frontmatter=true
  frontmatter_compliance INTEGER,  -- parsed from frontmatter (NULL = no frontmatter)
  content_hash TEXT,            -- SHA1 of file content for change detection
  size_bytes INTEGER,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  anomaly INTEGER NOT NULL DEFAULT 0,  -- 1 if file is in memory/ but frontmatter says compliant
  anomaly_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_type, file_path)
);
```

### Memory Scanner Service

A background service (registered via `registerService`) that:
1. Scans all agent workspace `memory/` and `memory-compliant/` directories on startup + periodically (every 5 min)
2. Parses YAML frontmatter from each file
3. Upserts rows in `memory_compliance_index`
4. Detects and logs anomalies (files in `memory/` tagged compliant)
5. Does NOT auto-move files — anomalies are reported, not silently fixed

### API Enhancements: `memories-fs`

Add `compliance_filter` query parameter:

| Value | Returns |
|-------|---------|
| `cloud` | Only memories from `memory/` (non-compliant) |
| `local` | Memories from both `memory/` and `memory-compliant/` |
| `all` | Same as `local` — all memories |
| (absent) | All memories (backward compat) |

New endpoint: `GET /api/memories-fs/compliance-summary`  
Returns counts per agent: total memories, compliant count, non-compliant count, anomaly count.

New endpoint: `GET /api/memories-fs/anomalies`  
Returns list of memory files that are misplaced (in `memory/` but tagged compliant, or vice versa).

### Prompt-Build Hook Enhancement

In `before_prompt_build`, after the task + project lookup:

```typescript
// New: compliance memory injection
const isCompliant = task.complianceRequired || (project?.complianceRequired ?? false);
if (isCompliant) {
  const agentType = run.agentType ?? "programmer";
  const compliantMemFiles = await readCompliantMemories(agentType);
  if (compliantMemFiles.length > 0) {
    return {
      prependContext: existingContext + "\n\n<compliance-memories>\n" + compliantMemFiles.join("\n\n") + "\n</compliance-memories>",
    };
  }
}
```

This ensures compliance-mode sessions get their sensitive memory context while non-compliance sessions never do.

### Model Classification Utility

New utility `src/util/compliance-model.ts`:

```typescript
const LOCAL_MODEL_PREFIXES = ['local/', 'ollama/'];

export function isLocalModel(model: string): boolean {
  return LOCAL_MODEL_PREFIXES.some(p => model.toLowerCase().startsWith(p));
}

export function isCloudModel(model: string): boolean {
  return !isLocalModel(model);
}

// Also check against configured compliance_model setting
export function isComplianceModel(model: string, configuredComplianceModel?: string): boolean {
  return isLocalModel(model) || model === configuredComplianceModel;
}
```

---

## Tradeoffs Considered

### Option A: Frontmatter-only enforcement (rejected)
Parse every memory file's frontmatter and filter based on tags. 

- **Pro**: Single directory, simpler mental model
- **Con**: lobs core injects files before the plugin hook runs, making filtering impossible at the plugin layer. Also fragile — easy to forget the frontmatter.

### Option B: DB-backed memory store (rejected for now)
Move all memories out of files and into the DB, with a `compliance_required` column.

- **Pro**: Clean enforcement, easy querying
- **Con**: Massive change to existing agent workflow. Agents write memory files directly. Would require rewriting lobs's memory system.

### Option C: Directory separation (chosen)
Structural enforcement via two directories.

- **Pro**: Enforced by file system structure — impossible to accidentally bypass. Compatible with lobs core. No changes to agent memory-writing workflow except the location.
- **Con**: Agents need to know which directory to write to. Migration needed for any existing sensitive memories.

**Decision**: Option C with frontmatter as the metadata/validation layer.

---

## Implementation Plan

See implementation tasks below.

### Testing Strategy

1. **Unit tests** (`src/util/compliance-model.test.ts`):
   - `isLocalModel('ollama/llama3')` → true
   - `isCloudModel('anthropic/claude-sonnet-4-6')` → true
   - Frontmatter parser: `compliance_required: true` parses correctly

2. **Unit tests** (`src/api/memories-fs.test.ts`):
   - `?compliance_filter=cloud` excludes `memory-compliant/` files
   - `?compliance_filter=local` includes both directories
   - Anomaly detection flags files in wrong directory

3. **Integration test**: 
   - Spawn compliant task → prompt-build hook injects compliant memories
   - Spawn non-compliant task → prompt-build hook does NOT inject compliant memories
   - Cloud model session → memories-fs API returns only non-compliant memories

---

## Implementation Tasks (for Programmer)

### Task 1: DB migration + schema update
- Add `memory_compliance_index` table to `migrate.ts`
- Add table definition to `schema.ts`

### Task 2: Compliance model utility
- Create `src/util/compliance-model.ts`
- Exports: `isLocalModel`, `isCloudModel`, `isComplianceModel`
- Unit tests

### Task 3: Frontmatter parser utility
- Create `src/util/memory-frontmatter.ts`
- Parse YAML frontmatter from memory file content
- Returns `{ complianceRequired: boolean, tags: string[] }` (defaults for missing frontmatter)
- Unit tests with various frontmatter formats + no-frontmatter files

### Task 4: Memory scanner service
- Create `src/services/memory-scanner.ts`
- Implements background scan: reads all agent workspace `memory/` and `memory-compliant/` dirs
- Upserts `memory_compliance_index` rows with content hash + compliance status
- Flags anomalies (misplaced files)
- Register as periodic service (5-min interval) in `index.ts`
- Also expose `scanNow()` for on-demand use

### Task 5: `memories-fs` API enhancement
- Add `compliance_filter` query param support
- Add `/api/memories-fs/compliance-summary` endpoint
- Add `/api/memories-fs/anomalies` endpoint
- Read from both `memory/` and `memory-compliant/` when filter is `local|all`
- Only read from `memory/` when filter is `cloud`

### Task 6: `before_prompt_build` hook enhancement
- After existing task/project lookup, check `task.complianceRequired || project?.complianceRequired`
- If compliant session: read `memory-compliant/{agent}/` files and append to `prependContext`
- Wrap in `<compliance-memories>` XML tags for clear context separation

### Task 7: Create `memory-compliant/` directories
- One-time setup: create `memory-compliant/` dirs for all known agent types
- Add a `.gitkeep` so dirs are tracked in version control
- Document the two-directory contract in `README.md`

### Task 8: `memory-compliance` API (tagging + moving)
- New endpoint: `POST /api/memories/tag` — update frontmatter compliance tag on a memory file
- New endpoint: `POST /api/memories/move` — move a memory file between `memory/` and `memory-compliant/`
- New endpoint: `PATCH /api/memories/:agent/:filename/compliance` — set compliance flag

---

## Rollout Order

1. Tasks 1, 2, 3 (foundation — no user-visible changes)
2. Task 4 (scanner — starts building the index)
3. Task 5 (API — Nexus can show compliance info)
4. Task 6 (enforcement — the actual compliance gate)
5. Tasks 7, 8 (UX — make it usable)

---

## Files to Create/Modify

**New files:**
- `docs/decisions/ADR-bifurcated-memory-compliance.md` (this file)
- `src/util/compliance-model.ts`
- `src/util/memory-frontmatter.ts`
- `src/services/memory-scanner.ts`

**Modified files:**
- `src/db/schema.ts` — add `memory_compliance_index` table
- `src/db/migrate.ts` — add migration for the table
- `src/api/memories-fs.ts` — add compliance filtering
- `src/api/index.ts` — register new memory compliance endpoints
- `src/hooks/prompt-build.ts` — inject compliant memories for compliance sessions
- `src/index.ts` — register memory scanner service
