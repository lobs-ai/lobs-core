# HEARTBEAT.md — Control Loop Operations

## Overview
The heartbeat is a **5-minute interval control loop** that monitors system health, manages the backlog, and keeps continuous workers running. It is the central coordination mechanism for all autonomous work in lobs-core.

## Heartbeat Interval
```typescript
// Registered as a system job in src/main.ts:
// cron: "*/5 * * * *" — every 5 minutes
// ADR-008: continuous monitoring
```
Defined in `src/orchestrator/heartbeat.ts` (`runHeartbeat()`).

## Control Loop Steps (per heartbeat tick)

### 1. Health Probes
Run health checks in parallel:
- **Database probe** — `SELECT 1` via SQLite
- **Memory probe** — HTTP GET to `lobs-memory` on `:7420`
- **LM Studio probe** — check if LM Studio is running (for `micro` tier)
- **Disk probe** — `df` check on workspace root

If all probes pass → `healthLevel = "healthy"`
If 1 probe fails → `healthLevel = "degraded"` (log warning, continue)
If 2+ probes fail → `healthLevel = "critical"` (log error, skip spawning, escalate to Rafe)

### 2. Backlog Management
Call `getNextTasks()` from the scheduler:
- Returns queued tasks sorted by priority, filtered to available agents
- Each task: `{ task, agent, source, priority }`

### 3. Continuous Worker Management
Maintains `spawnedWorkers: Map<string, SpawnedWorker>` across heartbeats.

**Worker lifecycle:**
1. **Spawn** — from backlog tasks with `source: "backlog"` (triggered by heartbeat)
2. **Track** — add to `spawnedWorkers` with `spawnedAt: Date.now()`
3. **Monitor** — on each heartbeat, check if running workers are making progress
4. **Escalate** — workers that fail 2+ times are re-spawned with `modelTier: "strong"`
5. **Detect stuck workers** — workers running >45 minutes with no tool calls → log error
6. **Prune** — remove completed/failed workers from `spawnedWorkers`

**Stuck worker threshold:** `STUCK_WORKER_THRESHOLD_MS = 45 * 60 * 1000`

### 4. Lint Check
If `spawnedWorkers.size > 0` and no lint has run in the last 10 minutes, trigger lint check with a 20-minute timeout. This catches build errors from continuous work.

## Scheduler Config
`getSchedulerConfig()` reads `~/.lobs/scheduler-config.json`. Schema:
```json
{
  "enabled": true,
  "maxConcurrentWorkers": 4,
  "preferHighPriority": true,
  "modelTierPolicy": {
    "default": "medium",
    "escalateAfterFailures": 2,
    "escalateTo": "strong",
    "fallbackTier": "micro"
  },
  "stuckWorkerThresholdMs": 2700000
}
```

## Health Levels
| Level | Meaning | Action |
|-------|---------|--------|
| `healthy` | All probes pass | Normal operation |
| `degraded` | 1 probe fails | Log warning, continue |
| `critical` | 2+ probes fail | Skip spawning, alert Rafe |

## Implementation Status
- ✅ Phase 1: Health probe system with database, memory, LM Studio, disk probes
- ✅ Phase 2: Backlog integration via `getNextTasks()`
- ✅ Phase 3: Continuous worker system (spawn, track, escalate, prune)
- ✅ Phase 4: Cron job integration — system jobs registered in `main.ts`, strategic reflection workflow firing
- ✅ Phase 5: Fallback chain implementation (`strong` → `medium` → `small`)
- ✅ Phase 6: Strong tier policy — auto-escalation after 2+ failures (`heartbeat.ts:427-441`)
- ✅ Phase 7: Cost audit cron — registered in `main.ts`, runs weekly on Sunday midnight

## Key Functions
- `runHeartbeat()` — main control loop, registered as system cron `*/5 * * * *` in `main.ts`
- `runHealthProbes()` — parallel probe execution, returns `HealthResult`
- `spawnWorkerFromTask()` — spawns a continuous worker from a queued task
- `checkStuckWorkers()` — detects and handles stuck workers
- `runLintCheck()` — triggers lint if continuous work is running
- `getSchedulerConfig()` — reads scheduler configuration
- `getNextTasks()` — queries queued tasks from the scheduler