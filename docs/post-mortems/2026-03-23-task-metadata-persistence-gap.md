# Post-Mortem: Task Metadata Persistence Gap (`shape` / `priority`)

**Date:** 2026-03-23  
**Affected tasks:** d131a765, 971f07a8, f2ef419a, 7b22c1cc (LM Studio monitoring phases 1–4)  
**Severity:** Medium — blocked prioritisation and hand-offs but didn't cause data loss

---

## What Happened

A writer agent session (23b9a03d, 2026-03-23T00:16:24Z) successfully restored full descriptions,
assigned `shape='tier-1'` and `priority='high'` to all 4 LM Studio phase tasks via PATCH requests.
The API returned `200 OK` but the values were silently discarded — they were never persisted.
A subsequent read of the tasks showed `shape=null` and `priority='medium'` (unchanged defaults).

## Root Cause

The PATCH handler in `src/api/tasks.ts` uses an explicit `fieldMap` to whitelist updatable fields.
Neither `shape` nor `priority` was in the map, so those request keys were silently ignored:

```ts
// BEFORE (missing entries):
const fieldMap = {
  title: "title",
  status: "status",
  notes: "notes",
  ...
  // shape and priority NOT listed — silently dropped
};
```

The API returned the *pre-existing* row from `SELECT … WHERE id = ?` after the (no-op) update,
making it appear the write succeeded.

## Fix Applied

1. **`src/api/tasks.ts`** — added `shape` and `priority` to the PATCH `fieldMap`.
2. **`src/cli/paw-task.ts`** — added `shape` and `priority` to the CLI `update` command's field map.
3. **`scripts/check-task-metadata.sh`** — new validation script that scans active tasks for missing
   `shape` and `priority`; exits 1 (suitable for CI / pre-push hook).
4. **`tests/tasks-api.test.ts`** — 2 new unit tests confirming `shape` and `priority` round-trip
   correctly through PATCH.
5. **Direct SQLite** — all 4 phase tasks and 4 other active tasks backfilled with correct values.

## Verification

```
$ ./scripts/check-task-metadata.sh
🔍 Checking active task metadata in /Users/lobs/.lobs/lobs.db...
✅ All active tasks have complete metadata (shape + priority)

$ npx vitest run tests/tasks-api.test.ts
✓ tests/tasks-api.test.ts (50 tests) — PASS
```

## Prevention

- **CI/pre-push:** add `scripts/check-task-metadata.sh` to pre-push hook (see `scripts/pre-push`).
- **Principle:** when adding a new column to the `tasks` table, always audit the PATCH `fieldMap`
  in `src/api/tasks.ts` **and** the CLI update map in `src/cli/paw-task.ts` before merging.
- **Silent success is dangerous:** the PATCH handler should log a warning when an incoming key is
  not in the fieldMap (future improvement — out of scope here).

## Final Task State

| Task ID | Phase | shape | priority |
|---------|-------|-------|----------|
| d131a765 | Phase 1 — preflight health check | tier-1 | high |
| 971f07a8 | Phase 2 — tunable thresholds | tier-1 | high |
| f2ef419a | Phase 3 — Prometheus metrics | tier-1 | high |
| 7b22c1cc | Phase 4 — E2E integration tests | tier-1 | high |
