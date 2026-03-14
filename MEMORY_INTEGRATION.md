# lobs-memory Direct Integration

## Summary

Integrated lobs-memory search directly into lobs-core with HTTP + grep fallback for resilience.

## Implementation

### 1. Bridge Module (`src/services/memory-search.ts`)

- **Primary mode**: HTTP to localhost:7420 (supervised memory server)
- **Fallback mode**: Simple grep-based search across markdown files
- **Timeout**: 5 seconds for HTTP (prevents blocking)
- **Search directories**:
  - `~/.openclaw/workspace`
  - `~/lobs/lobs-shared-memory`
  - `~/lobs/lobs-core`
  - `~/paw/bot-shared`
  - `~/paw/paw-hub`
  - `~/paw/paw-designs`

### 2. Updated Memory Tools (`src/runner/tools/memory.ts`)

- Now uses `memorySearch()` from bridge instead of direct HTTP fetch
- Returns search source (`server` or `grep`) in results
- Same tool interface — no changes to agent-facing API
- Removed hardcoded `MEMORY_SERVER` constant

### 3. Updated Config Paths (`memory/config.json`)

Updated collection paths to match organized directory structure:
- `~/lobs-shared-memory` → `~/lobs/lobs-shared-memory`
- `~/paw-hub` → `~/paw/paw-hub`
- `~/lobs-mobile` → `~/lobs/lobs-mobile`
- `~/lobs-memory` → `~/lobs/lobs-core/memory`
- `~/paw-designs` → `~/paw/paw-designs`
- `~/bot-shared` → `~/paw/bot-shared`

## Why This Approach?

**Direct import not feasible**: lobs-memory uses `bun:sqlite` which doesn't work in Node. Converting to `better-sqlite3` would be a major refactor and out of scope.

**HTTP + grep = best of both worlds**:
- HTTP: Fast, semantic search with BM25 + vector + reranking (when server is up)
- Grep: Always-available fallback (when server is restarting/indexing/crashed)
- No single point of failure

## Testing

```bash
# Compile check
cd ~/lobs/lobs-core && npx tsc --noEmit

# Build
npm run build

# Test search (via bridge)
node -e "import('./dist/services/memory-search.js').then(m => m.memorySearch('test query', 3).then(console.log))"
```

## Results

- ✅ TypeScript compiles cleanly (0 errors)
- ✅ Build succeeds
- ✅ Memory tools load correctly
- ✅ HTTP mode works (tested with live server)
- ✅ Grep fallback implemented (ready for server downtime)
- ✅ Config paths updated to match organized structure
- ✅ No new npm dependencies added
- ✅ Tool interface unchanged (backward compatible)

## Files Modified

- `src/services/memory-search.ts` (new)
- `src/runner/tools/memory.ts` (updated to use bridge)
- `memory/config.json` (updated paths)
- `src/api/chat.ts` (fixed pre-existing TypeScript error)
