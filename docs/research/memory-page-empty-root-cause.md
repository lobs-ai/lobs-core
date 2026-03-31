# Research Memo: Nexus Memory Page Shows Empty / API Returns totalMemories: 0

**Date:** 2026-03-31  
**Investigator:** Researcher Agent  
**Status:** Root cause confirmed ✅

---

## Question / Topic

Why does `http://localhost:9420/api/structured-memory/stats` return `totalMemories: 0` and all zeros, causing the Nexus Memory page to appear empty — despite `~/.lobs/structured-memory.db` being 18MB and containing real data?

---

## Key Findings

### 1. The DB Has Substantial Real Data

`structured-memory.db` (18MB) is healthy and populated:

| Table | Row Count |
|---|---|
| `events` | **6,978** |
| `memories` | **1,135** |
| `conflicts` | 174 |
| `evidence` | 2,604 |
| `memory_embeddings` | 1,072 |
| `reflection_runs` | 308 |
| `retrieval_log` | 1,040 |

Memory breakdown (by type/status):
- decisions: 143 active, 81 superseded, 26 archived
- facts: 250 active, 110 superseded, 43 archived
- learnings: 236 active, 109 superseded, 28 archived
- patterns: 33 active, 22 superseded
- preferences: 41 active

Events span **2026-03-27 → 2026-03-30**, covering agent actions (3,415), tool results (2,242), observations (1,034), user inputs (280).

The 18MB is primarily `memory_embeddings` (~13MB of embedding vectors) + `events` (~3MB).

**The data exists and is being written correctly.**

---

### 2. The API Returns Zeros Because It Cannot Find Its DB

The stats API at `src/api/structured-memory.ts` uses this pattern:

```typescript
function tryDb() {
  try {
    return getMemoryDb();
  } catch {
    return null;  // ← silently returns null on any error
  }
}

function handleStats(res: ServerResponse): void {
  const db = tryDb();
  if (!db) {
    json(res, { totalMemories: 0, totalEvents: 0, ... });  // ← returns zeros
    return;
  }
  // ... real queries never run
}
```

`getMemoryDb()` throws (or returns null) because the **singleton `_db` was never initialized against `structured-memory.db`** in the running process.

---

### 3. Root Cause: Stale Process + DB Rename (Two-Part Bug)

**Part A — The process opened the wrong DB at startup:**

The running process (PID 46294) started at **Sun Mar 29 22:29:58**. At that time, `dist/memory/db.js` pointed to the **old path** `~/.lobs/memory.db` (the pre-ADR-007 lobs-memory service DB). The `initMemoryDb()` call at startup opened `memory.db` and stored it in the module-level `_db` singleton.

Confirmed via `lsof`:
```
node 46294  /Users/lobs/.lobs/memory.db       ← old DB, opened at startup
node 46294  /Users/lobs/.lobs/memory.db-shm   ← WAL shared memory
node 46294  /Users/lobs/.lobs/memory.db-wal   ← WAL
# structured-memory.db: NOT IN LSOF OUTPUT
```

**Part B — `memory.db` has the wrong schema:**

`memory.db` was the old **document chunk store** (lobs-memory service), with tables: `chunks`, `documents`, `chunk_embeddings`, `graph_edges`, etc. It has **no `memories` table, no `events` table**. When the API's stats query runs against it, all `COUNT(*)` calls fail or return 0 — which `tryDb()`'s `catch` silences.

**Part C — The dist was rebuilt after the process started:**

```
Process start:           Mar 29 22:29
dist/memory/db.js mtime: Mar 30 23:41  ← rebuilt the NEXT DAY
structured-memory.db:    created Mar 26, last modified Mar 29 22:26
```

The dist was rebuilt to use `structured-memory.db`, but **the running process still has the old in-memory module code** pointing to `memory.db`. Node.js loaded the module once at startup — disk changes have no effect on the live process.

---

### 4. Why `tryDb()` Returns Null

When the stats API calls `getMemoryDb()`:
```typescript
export function getMemoryDb(): Database.Database {
  if (!_db) {
    throw new Error("Memory database not initialised — call initMemoryDb() first");
  }
  return _db;
}
```

The `_db` singleton **was** set — but it's the old `memory.db` connection. When the stats SQL queries run against it (looking for `memories`, `events` tables), they throw `"no such table"` errors. Those propagate up through `tryDb()`'s catch → `null` → zeros response.

---

### 5. What Is Taking Up 18MB

| Size | Table / File |
|---|---|
| ~13.2 MB | `memory_embeddings` — 1,072 embedding vectors |
| ~3.0 MB | `events` — 6,978 runtime event records |
| ~0.5 MB | `memories` — 1,135 structured memories |
| ~0.3 MB | `memories_fts_*` — full-text search index |
| ~0.1 MB | `evidence`, `conflicts`, indexes |

This is entirely legitimate data.

---

## Root Cause Summary

```
Timeline:
  Mar 26        structured-memory.db created (new unified DB)
  Mar 29 22:26  structured-memory.db last written (final WAL flush)
  Mar 29 22:29  Process (PID 46294) started — loads OLD dist → opens memory.db
  Mar 30 23:41  dist/memory/db.js rebuilt → now references structured-memory.db
                (but running process is unaffected — module already loaded)

Result:
  - Writes go to:  structured-memory.db (written by EventRecorder/MemoryWriter at runtime)
  - API reads from: memory.db (what _db singleton holds, from old startup)
  - memory.db has no 'memories' or 'events' tables → API returns all zeros
```

**TL;DR: The lobs-core process started before the ADR-007 dist rebuild, opened the old `memory.db`, and is still reading from it. All real data is in `structured-memory.db`. The fix is to restart the process.**

---

## Recommendation

### Immediate Fix
**Restart the lobs-core process.** When it starts fresh, it will load the current dist, call `initMemoryDb()` against `structured-memory.db`, and the API will return the correct 1,135 memories + 6,978 events.

```bash
# Kill and restart (however lobs-core is managed)
kill 46294
# then restart via pm2, launchd, or manually
```

### Medium-Term Fix: Safer `tryDb()` Logging

The silent `catch → null → zeros` pattern in `handleStats()` hides the real error. It should log:

```typescript
function tryDb() {
  try {
    return getMemoryDb();
  } catch (err) {
    console.error("[structured-memory API] getMemoryDb() failed:", err);
    return null;
  }
}
```

This would have surfaced `"no such table: memories"` in logs immediately.

### Long-Term Fix: Schema Version Guard

Add a schema version check at startup in `initMemoryDb()` — if the opened DB has the wrong schema (e.g., no `memories` table), throw loudly rather than silently proceeding.

---

## Sources / References

- Live DB: `~/.lobs/structured-memory.db` — sqlite3 queries run 2026-03-31
- Live DB: `~/.lobs/memory.db` — schema confirmed via sqlite3 `.tables`
- Running process: `lsof -p 46294` — confirmed open file handles
- Source: `~/lobs/lobs-core/src/api/structured-memory.ts` lines 22–50 — `tryDb()` pattern
- Source: `~/lobs/lobs-core/src/memory/db.ts` lines 15, 188, 229, 239 — singleton `_db`
- Source: `~/lobs/lobs-core/src/main.ts` lines 297–302 — `initMemoryDb()` at startup
- Process metadata: `ps -p 46294` — started Sun Mar 29 22:29:58 2026
- Dist file: `~/lobs/lobs-core/dist/memory/db.js` — mtime Mar 30 23:41 (rebuilt after process start)
- ADR-007: `~/lobs-shared-memory/adrs/adr-007-unified-memory-system.md`
- Commit `7eb239a` (2026-03-30 10:48): ADR-007 Phase 3 — removed lobs-memory service
