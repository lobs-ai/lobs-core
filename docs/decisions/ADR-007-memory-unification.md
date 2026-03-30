# ADR-007: Memory Unification

**Status:** Complete  
**Date:** 2026-03-30  
**Driver:** Rafe + Lobs

## Context

lobs-core had two independent memory systems:

1. **Old system** (`src/services/memory/`) — an in-process search engine with its own chunker, embedder, indexer, graph, and BM25/vector search. Supervised by `memory-server.ts`, bridged through `memory-client.ts`. Complex, redundant, and hard to maintain.

2. **New system** (`src/memory/`) — structured memory in SQLite (`structured-memory.db`) with typed memories (fact, preference, decision, procedure, episode, document), evidence tracking, confidence scoring, GC lifecycle, and FTS5+vector hybrid search.

Both systems coexisted awkwardly — context assembly had fallback paths, health checks monitored both, and startup initialized both. The old system was effectively dead weight.

## Decision

Unify all memory operations through the new `src/memory/` system. Remove the old `src/services/memory/` infrastructure entirely.

## Implementation

### Phase 1: Unified Search in Context Engine (commit f87de6e)
- `context-engine.ts` now calls `searchMemoriesFull()` from `src/memory/search.ts` as the primary path
- Results mapped to context chunks with proper category assignment
- Old `memory-client.ts` kept only as catch fallback (removed in Phase 3)

### Phase 2: Cross-Type Conflict Detection + Tool Unification
- Reflection pipeline detects conflicts across memory types (commit 7021837)
- `memory_search` tool routes through unified search (commit 8cf015c)
- Schema fixes for fresh-DB setup (commit 662aed0)
- Test timeout and FK constraint fixes (commit d5124e8)

### Phase 3: Legacy Service Removal (commit 7eb239a)
**Deleted:**
- `src/services/memory/` — entire directory (14 files: chunker, config, db, embedder, entities, expander, graph, index, indexer-worker, indexer, parsers, reranker, search, types)
- `src/services/memory-client.ts` — bridge to old system
- `src/services/memory-search.ts` — deprecated search bridge
- `src/services/memory-server.ts` — process supervisor
- `tests/memory-server.test.ts`

**Updated:**
- `src/main.ts` — removed `initMemory()`/`shutdownMemory()` calls
- `src/api/health.ts` — health checks now query unified DB directly
- `src/orchestrator/heartbeat.ts` — uses `getMemoryDb()` check
- `src/runner/context-engine.ts` — removed `memorySearchBatch` fallback
- `src/services/context-assembler.ts` — switched to `searchMemoriesFast`
- `src/services/discord-commands.ts` — switched to `getMemoryDb()` check
- `tests/health-api.test.ts` — mocks updated for new system

**Preserved (independent):**
- `src/services/memory-condenser.ts` — daily memory file management
- `src/services/memory-scanner.ts` — compliance scanning

## Result

- 103 test files, 2468 tests passing
- Single memory system: `src/memory/` with SQLite-backed structured storage
- Simpler startup (no dual initialization)
- Cleaner health checks (no port 7420 monitoring)
- ~2000 lines of dead code removed
