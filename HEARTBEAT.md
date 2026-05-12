# HEARTBEAT.md — System Heartbeat

**ADR-008:** [docs/decisions/ADR-008-unlimited-operations.md](docs/decisions/ADR-008-unlimited-operations.md)

## Operating Posture

The heartbeat operates in **aggressive autonomous mode** (ADR-008 Phase 3). The system is never idle when there is work to do. Cost is no longer a gating factor — impact is.

> **Old posture:** Conservative. Monitor, alert, let Rafe decide.
> **New posture:** Proactive. Monitor, then act. Fill idle capacity with backlog work.

## Actions (in order)

### 1. Health Checks (non-blocking, ~5s)

| Check | What it monitors | Alert threshold |
|-------|-----------------|-----------------|
| `lobsCore` | Process alive | Always ok (if heartbeat runs) |
| `memoryServer` | Unified memory DB accessible | Error |
| `lmStudio` | Local model server reachable | Warning (local-only) |
| `tasks` | Active/failed/blocked counts | >5 failed, >10 blocked |
| `workers` | Completions vs failures (last hour) | >50% failure rate |
| `inbox` | Unread actionable items | >20 unread |

Health checks must **never block** spawning. A degraded health status produces an alert but the heartbeat continues to the worker spawning phase.

### 2. Continuous Worker Spawning (primary action)

After health checks, the heartbeat queries the scheduler for the next batch of tasks to work on:

```typescript
import { getNextTasks, getSchedulerConfig } from "./orchestrator/scheduler.js";

const config = getSchedulerConfig();
const tasks = getNextTasks(config);
```

**Limits:** Max 3 concurrent workers total (enforced by scheduler's `maxConcurrentWorkers`). The heartbeat spawns up to `maxConcurrentWorkers` workers per cycle — enough to keep the pipeline moving without overwhelming the system.

**Selection criteria (per ADR-008):**
- Urgency-weighted priority (high > medium > low)
- Task age (older tasks score higher)
- Cost efficiency (cheaper tasks preferred — less relevant now that MiniMax is $0)

**Spawning logic:**
- For each selected task, spawn using `runAgent()` with the task's `agent` type
- Default agent: `task.agent ?? 'programmer'`
- Default model tier: `task.modelTier ?? 'medium'`
- Log every spawn: `[HEARTBEAT] Spawning {agent} on task {id} ({title})`

**What NOT to do:**
- Do not wait for workers to complete before returning — spawning is fire-and-forget
- Do not override task assignment or redistribute work
- Do not retry failed workers in this phase — that is handled by the failure tracking in `control-loop.ts`

### 3. Stuck Worker Detection

On each heartbeat, if a worker has been running for >45 minutes without completion, log a warning:

```
[HEARTBEAT] Worker {workerId} may be stuck (task={taskId}, duration={N}m)
```

This is informational only — heartbeat does not kill workers. Stuck worker recovery is handled by `control-loop.ts` checkpoint logic and the researcher escalation path.

### 4. Alert Forwarding

Alerts from health checks are collected and returned in `HeartbeatResult.alerts`. The cron scheduler (or external monitoring) is responsible for paging Rafe if alerts persist across 3+ consecutive heartbeats. The heartbeat itself does not page — it only reports.

## Cycle Frequency

- **Every 5 minutes** via cron (`*/5 * * * *`)
- Each cycle: ~5s health checks + up to 2s per spawned worker (non-blocking)
- Total cycle time: <10 seconds

## No Idle Heartbeats

Every heartbeat cycle should produce at least one action. If there are no tasks to spawn and all health checks pass, log:

```
[HEARTBEAT] ✓ All healthy, no pending tasks
```

If there are pending tasks but no available worker slots, log:

```
[HEARTBEAT] No slots available ({active}/{max} workers active)
```

## Failure Handling

- If spawning fails (e.g., model unavailable), log the error and **continue** — do not retry within the same cycle
- Failed spawns are tracked in `worker_runs` table with `succeeded=0`; the scheduler will re-select them on the next cycle
- The researcher escalation path (control-loop.ts) handles tasks that fail repeatedly

## Relationship to Other Systems

| System | Role |
|--------|------|
| `scheduler.ts` | Decides which tasks to run, enforces concurrency limits |
| `control-loop.ts` | Handles workflow-driven task spawning (from workflow definitions) |
| `worker-manager.ts` | Tracks active workers, handles session management |
| `heartbeat.ts` | Fills idle capacity with backlog tasks (this file) |

Heartbeat spawning and workflow spawning are **independent paths** that both write to `worker_runs`. The scheduler's concurrency guard (`maxConcurrentWorkers`) prevents oversubscription regardless of which path spawns the worker.

## References

- [ADR-008: Unlimited Operations](docs/decisions/ADR-008-unlimited-operations.md)
- [Scheduler](src/orchestrator/scheduler.ts)
- [Worker Manager](src/orchestrator/worker-manager.ts)
- [Control Loop](src/orchestrator/control-loop.ts)
- [Cost Audit Cron](src/orchestrator/cost-audit.ts) — weekly spend verification per ADR-008 Phase 7

## ADR-008 Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Models config update (MiniMax at $0) | ✅ Done |
| 2 | HEARTBEAT.md rewrite (aggressive autonomous mode) | ✅ Done |
| 3 | Continuous worker system (heartbeat spawns workers) | Pending |
| 4 | New cron jobs (CI runner, GitHub triage, dependency monitor, test impact) | Partial |
| 5 | Fallback chain updates (local → MiniMax → strong) | Pending |
| 6 | Strong tier auto-escalation | Pending |
| 7 | **Cost audit cron — weekly spend verification** | ✅ Done |
