# Design: Orphaned Session Recovery Under Restart Stress

**Date:** 2026-03-18  
**Status:** Proposed  
**Priority:** P0 — 4 orphaned-on-restart failures in 6h; detection latency 3min vs 30s target  
**Related:** [2026-03-16 Restart Cascade Post-Mortem](../post-mortems/2026-03-16-restart-cascade.md), Action Items AI-07/AI-08/AI-10  
**Scope:** lobs-core orchestrator (control-loop, worker-manager, restart-telemetry)

---

## Problem Statement

The 2026-03-16 post-mortem identified orphaned sessions as a consequence of restart cascades and shipped `restart-telemetry.ts` as a detection mechanism. **This detection layer is not working.** Evidence from the last 6 hours:

1. **4 orphaned-on-restart failures** — workers spawned before a restart are left in `in_progress` state with no running process. The ghost-run watchdog (phase 9 of the control loop) eventually catches them, but only after the 12-minute session-file mtime grace period expires.
2. **Detection latency ~3 min** vs the 30s target — the telemetry fires warnings but does not trigger remediation. The orchestrator's 10-second tick loop doesn't re-check worker liveness until the *next* scan after restart, and the 12-min grace window means even a detected orphan waits minutes before cleanup.
3. **Root cause gap** — the post-mortem shipped *observability* (restart-frequency counter, disk-space probe, gateway token probe) but did not ship *recovery*. There is no mechanism to:
   - Enumerate in-flight workers at shutdown
   - Fast-detect orphaned workers on startup
   - Distinguish "worker process died due to restart" from "worker is slow"

The post-mortem's action items AI-07 (restart-lock), AI-08 (minimum uptime guard), and AI-10 (session checkpoint/resume) address prevention and eventual recovery, but none address the **immediate detection gap** for workers orphaned *right now* by a restart that already happened.

---

## Why the Current Architecture Fails

### The 12-Minute Grace Period Is the Wrong Default for Restart Orphans

The ghost-run watchdog (control-loop phase 9) checks `worker_runs` where:
- `ended_at IS NULL` (still running)  
- Session file mtime is older than 12 minutes (no recent activity)

This 12-minute window is tuned for **slow agents** (e.g., strong-model workers doing complex tasks). It's correct for detecting workers that have silently stalled. It is **catastrophically wrong** for detecting workers killed by a restart — those workers are dead immediately, but the watchdog won't notice for 12 minutes.

### No Shutdown Manifest

When lobs-core receives SIGTERM/SIGINT for a graceful restart, it:
1. Stops accepting new work  
2. Exits  

It does **not**:
- Write a list of in-flight `worker_runs` to disk  
- Mark in-flight `worker_runs` as `orphaned_by_restart` in the DB  
- Record its own PID alongside worker state  

So on startup, the new process has no way to distinguish "worker_run X was in-flight when my predecessor died" from "worker_run X is still happily running."

### Session File Mtime Is a Weak Liveness Signal

The orchestrator checks the session file's mtime as a proxy for "is this worker alive." This is unreliable because:
- Session files may be updated by filesystem events unrelated to the worker
- A killed worker's session file retains its last mtime — there is no write-on-death
- The mtime check + 12-min grace means the *minimum* detection time for a dead worker is 12 minutes, and the *maximum* is 12 minutes + one tick interval (10s)

---

## Proposed Solution

A three-layer defense: **Shutdown Manifest** (fast identification), **Startup Reconciliation** (fast cleanup), and **PID-Based Liveness** (fast ongoing detection). Each layer is independently useful; together they bring detection latency from ~12 min to < 30s.

### Layer 1: Shutdown Manifest

**When:** SIGTERM/SIGINT handler, before process exit.  
**What:** Write a `shutdown-manifest.json` to `~/.lobs/plugins/lobs/` containing:

```json
{
  "shutdownAt": "2026-03-18T14:22:00.000Z",
  "pid": 12345,
  "reason": "SIGTERM",
  "inFlightWorkers": [
    {
      "workerRunId": 42,
      "taskId": 15,
      "childSessionKey": "agent:worker:abc123",
      "spawnedAt": "2026-03-18T14:10:00.000Z",
      "agentType": "programmer",
      "workerPid": 12400
    }
  ]
}
```

**Implementation notes:**
- Use `fs.writeFileSync` — this is a shutdown path, async is unreliable
- Best-effort: if ENOSPC or other write failure, log and continue (don't block exit)
- The `workerPid` field is **optional** — we may not have it for all workers (Gateway-spawned sessions don't always expose the child PID). See Layer 3 for how we handle this.
- The manifest is consumed once on startup, then archived to `shutdown-manifests/` with timestamp suffix

**Cost:** ~10 lines in the existing SIGTERM handler. One synchronous file write. No DB queries on the shutdown path.

### Layer 2: Startup Reconciliation

**When:** First tick of the control loop after startup, before normal phases.  
**What:** A new phase 0 — `reconcileOrphanedWorkers()` — runs once on startup:

1. **Read the shutdown manifest** (if it exists)
2. **Query `worker_runs` where `ended_at IS NULL`** — these are all potentially orphaned runs
3. **For each open worker_run:**
   - If it appears in the shutdown manifest → it was definitely in-flight when the predecessor died → **immediately mark as orphaned**
   - If it does NOT appear in the manifest but the manifest exists → the worker was spawned *after* the manifest was written but before the process died (race window) → **treat as suspect, check PID liveness** (Layer 3)
   - If no manifest exists (crash, ENOSPC, etc.) → all open runs are suspect → **check PID liveness**

4. **For each orphaned worker_run:**
   - Set `ended_at = NOW()`, `succeeded = 0`, `failure_reason = 'orphaned_by_restart'`
   - Increment `crash_count` on the parent task (infra failure, not agent quality)
   - Reset task `work_state` to `not_started` so it re-enters the queue
   - Log WARN with the task ID, agent type, and how long the worker had been running

5. **Archive the manifest** to `shutdown-manifests/<timestamp>.json`

**Detection time:** First tick after startup = **≤ 10 seconds** from process start.

**Why not mark them in the SIGTERM handler directly?**  
Because the DB may be in an inconsistent state during shutdown (active transactions, WAL checkpoint in progress). Writing a flat JSON file is safer. The new process's DB connection is clean.

### Layer 3: PID-Based Liveness (Ongoing)

**When:** Every tick, as an enhancement to the existing ghost-run watchdog (phase 9).  
**What:** Replace the 12-minute mtime-only check with a two-tier check:

**Tier A — PID liveness (immediate, <1s):**
- For each open `worker_run`, check if the worker process is alive via `process.kill(pid, 0)` (signal 0 = existence check, no actual signal sent)
- If the PID is **not running** → the worker is dead → **immediately orphan it** (no grace period)
- If the PID **is running** → worker is alive, skip mtime check entirely

**Tier B — Mtime fallback (existing 12-min, for PID-unknown workers):**
- If we don't have a PID for the worker (Gateway-spawned, PID not captured) → fall back to existing mtime-based detection
- Keep the 12-minute grace period for this path — it's the only signal we have

**How to capture worker PIDs:**
- The `sessions_spawn` Gateway API returns a `sessionKey` but not a PID
- **Option A:** After spawn, query the Gateway's `/sessions` endpoint to get the PID for the session. Store in `worker_runs.worker_pid` column.
- **Option B:** Scrape the PID from the session file on disk (Gateway writes session metadata files that may include PID)
- **Option C:** When the Gateway doesn't expose PID, use `childSessionKey` to check if the session is still registered with the Gateway (HTTP liveness check to Gateway's session listing)

**Recommendation:** Start with Option C (session-key-based liveness check via Gateway API) — it doesn't require a DB migration, works with the existing spawn flow, and catches the "Gateway restarted and session is gone" case. Add `worker_pid` column (Option A) as a follow-up for cases where the Gateway itself is unavailable.

**New detection time for restart orphans:** ≤ 1 tick (10 seconds) after the worker dies.

---

## Architecture Diagram

```
         SIGTERM received
              │
              ▼
┌─────────────────────────────┐
│  SIGTERM Handler            │
│  1. Stop control loop       │
│  2. Query open worker_runs  │
│  3. Write shutdown-manifest │ ──▶ ~/.lobs/plugins/lobs/shutdown-manifest.json
│  4. Exit                    │
└─────────────────────────────┘

         Process starts
              │
              ▼
┌──────────────────────────────────────────────────┐
│  Startup / First Tick — Phase 0                  │
│                                                  │
│  ┌─────────────────────────┐                     │
│  │ Read shutdown manifest? │──── No manifest ───▶│─── Query open worker_runs
│  └────────┬────────────────┘                     │    Check each via Gateway
│           │ Manifest exists                      │    session API (Layer 3/C)
│           ▼                                      │
│  ┌─────────────────────────┐                     │
│  │ Match manifest workers  │                     │
│  │ to open worker_runs     │                     │
│  │ → orphan matched runs   │                     │
│  │ → check unmatched via   │                     │
│  │   Gateway session API   │                     │
│  └─────────────────────────┘                     │
│                                                  │
│  Result: all restart-orphaned runs marked        │
│  Tasks reset to not_started, crash_count++       │
└──────────────────────────────────────────────────┘

         Normal tick loop (every 10s)
              │
              ▼
┌──────────────────────────────────────────────────┐
│  Phase 9 (Enhanced Ghost-Run Watchdog)           │
│                                                  │
│  For each open worker_run:                       │
│    ├── Has PID? ──▶ kill(pid, 0) alive?          │
│    │   ├── Dead ──▶ ORPHAN immediately           │
│    │   └── Alive ──▶ OK, skip                    │
│    └── No PID? ──▶ Check Gateway session API     │
│        ├── Session gone ──▶ ORPHAN immediately   │
│        └── Session exists ──▶ mtime check (12m)  │
└──────────────────────────────────────────────────┘
```

---

## Data Changes

### New file: `shutdown-manifest.json`
- Location: `~/.lobs/plugins/lobs/shutdown-manifest.json`
- Written on shutdown, consumed on startup, archived after consumption
- Not in version control (ephemeral state)

### DB: `worker_runs` table
- **No schema change required for Layer 1 + 2**
- **Optional for Layer 3:** Add `worker_pid INTEGER` column (nullable). Only needed if we pursue Option A (PID storage). Option C (Gateway session check) needs no schema change.

### DB: `failure_reason` values
- New value: `'orphaned_by_restart'` — distinguishes restart orphans from other infra failures in reporting

---

## Phases / Delivery Plan

### Phase 1: Immediate (ship today) — Detection Latency Fix
- **Layer 2 (Startup Reconciliation)** without Layer 1 — query all open `worker_runs` on startup, check each via Gateway session API, orphan any whose session is no longer registered
- **Enhance Phase 9** with Gateway session check (Layer 3, Option C) — for ongoing detection between restarts
- **Expected improvement:** Detection latency from ~12 min → ~10 seconds for restart orphans

### Phase 2: This week — Shutdown Manifest
- **Layer 1** — SIGTERM handler writes shutdown-manifest.json
- Startup reconciliation now uses the manifest for **zero-query** identification of orphaned workers
- **Expected improvement:** Detection is now **certain** (manifest says exactly who was in-flight) rather than heuristic (checking if sessions still exist)

### Phase 3: Near-term — PID Tracking
- Add `worker_pid` column to `worker_runs`
- Capture PID at spawn time (query Gateway, or parse session metadata)
- Phase 9 uses `kill(pid, 0)` for immediate liveness check
- **Expected improvement:** Detection works even when Gateway is unavailable (e.g., Gateway itself restarted)

---

## Trade-offs

| Decision | Pro | Con |
|----------|-----|-----|
| Synchronous file write in SIGTERM handler | Reliable, fast, no async issues | Blocks shutdown by ~1ms; fails on ENOSPC (but we log and continue) |
| Gateway session API for liveness (Phase 1) | No schema change, works immediately | Adds 1 HTTP call per open worker per tick; fails if Gateway is down |
| PID-based liveness (Phase 3) | Works without Gateway, instant | Requires DB migration; PID may not be available for all spawn types |
| Resetting task to `not_started` | Task re-enters queue automatically | Worker may have partially completed work; re-run may duplicate effort |
| Classifying as `crash_count` (infra) | Doesn't penalize task quality tier | Could mask genuine agent failures if misclassified |

---

## Interaction with Post-Mortem Action Items

| Action Item | Relationship to This Design |
|-------------|----------------------------|
| **AI-07** (restart-lock) | *Complementary* — prevents restarts during active work. This design handles recovery *when restarts happen anyway*. |
| **AI-08** (minimum uptime guard) | *Complementary* — prevents rapid restart cascades. This design handles cleanup after any restart. |
| **AI-10** (session checkpoint/resume) | *Superset* — AI-10 envisions full session resumption. This design is the prerequisite: you can't resume sessions you haven't identified as orphaned. Phase 1-2 of this design enables AI-10. |
| **AI-02** (restart-frequency telemetry) | *Shipped but insufficient* — telemetry detects restart frequency but does not trigger cleanup. This design adds the missing remediation leg. |
| **AI-06** (clean PID on FATAL) | *Complementary* — ensures the shutdown manifest write path isn't blocked by stale PID issues. |

---

## Failure Modes

### What if the shutdown manifest write fails?
Layer 2 falls back to querying open `worker_runs` + checking Gateway session API. Detection latency stays at ~10s. The manifest is an optimization, not a hard dependency.

### What if the Gateway session API is unavailable on startup?
Fall back to mtime-based detection (existing behavior). Log WARN. This is the current behavior — no regression.

### What if a worker finishes right as a restart happens?
The worker's `ended_at` would be set in the DB by the worker itself (via the results callback). The startup reconciliation checks `ended_at IS NULL` — already-finished workers are excluded. No false orphaning.

### What if the new process starts before the old one fully exits?
The stale-PID detection (AI-06) handles this. But also: the shutdown manifest is written *before* exit, so it's available even in this race. The new process reads the manifest, sees the workers listed, checks liveness, and finds them still running (because the old process hasn't died yet). It waits one tick (10s) and checks again — by then the old process is gone and the workers are correctly orphaned.

### What about FATAL crashes (ENOSPC, uncaught exception)?
No manifest is written (SIGTERM handler doesn't fire on `ENOSPC` exceptions before crash). This is the worst case, but it's already the current behavior. The enhanced Phase 9 (Gateway session check) catches these within one tick of the new process starting — still ~10s, a massive improvement over 12 minutes.

---

## Metrics / Success Criteria

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Orphan detection latency | ~12 min | ≤ 30s | Time from restart to `orphaned_by_restart` log entry |
| Orphaned-on-restart failures per 24h | 4 in 6h (extrapolated: 16/day) | 0 undetected; ≤ 1 min to re-queue | Count of `failure_reason = 'orphaned_by_restart'` |
| Task re-queue time after orphan | ~12 min + next scan | ≤ 20s | Time from worker death to task `work_state = 'not_started'` |
| False orphan rate | N/A (new metric) | 0 | Count of workers marked orphaned that were actually still running |

---

## Open Questions

1. **Should we attempt to kill orphaned worker processes?** If a worker is still running (e.g., the Gateway kept it alive across the lobs-core restart), should we send SIGTERM to clean up? Or let it finish and just ignore its results? **Recommendation:** Let it finish — the `ended_at IS NULL` check means if it completes and writes results, we won't re-run the task.

2. **Should startup reconciliation block the first tick or run concurrently?** Blocking is safer (no new work spawned until orphans are cleaned up) but adds ~1-2s to startup. **Recommendation:** Block. Startup latency is not critical; spawning new work while old work is still being classified is a footgun.

3. **How does this interact with the Trident migration?** Trident's design (stateless workers, direct `runAgent()`, no Gateway session abstraction) eliminates several failure modes. PID tracking is trivial with direct spawning. The shutdown manifest pattern is still useful. **Recommendation:** Implement in lobs-core now for immediate value; the manifest pattern ports cleanly to Trident.
