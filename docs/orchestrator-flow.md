# Orchestrator Control Loop — Architecture Reference

**Source:** `~/lobs-plugin-lobs/src/orchestrator/`
**Last Updated:** 2026-03-09

---

## Overview

The PAW plugin orchestrator is a TypeScript Node.js control loop that runs inside the lobs Gateway process. It scans for work every 10 seconds and dispatches tasks to specialized sub-agents via the Gateway `sessions_spawn` API.

---

## Scan Loop

`startControlLoop(ctx, intervalMs)` sets up a `setInterval` at the configured interval (default **10 seconds**). Each tick calls `runTick()`, which executes the following phases in order:

1. Advance active workflow runs (up to 5 passes each)
2. Drain pending spawn requests (capacity + project-lock checks)
3. Fire event-triggered and schedule-triggered (cron) workflow runs
4. Scan for ready tasks → match to workflow → start run
5. Worker liveness checks (session-file mtime, 12-min grace)
6. Stale workflow run cleanup (2–10 min thresholds by node type)
7. Stall watchdog (per-agent-type silence thresholds)
8. Auto-close tasks where all `worker_runs` succeeded
9. Ghost-run watchdog (close orphaned `worker_runs`, reset task)
10. Meeting analysis recovery

---

## Task State Machine

```
           INSERT with status='active', work_state='not_started'
                              │
                              ▼
                     ┌────────────────┐
                     │  not_started   │◄──────────────────────┐
                     └───────┬────────┘  crash/infra reset    │
                             │ scanner picks up               │
                             ▼                                │
                     ┌───────────────┐                        │
                     │  workflow run │  (WorkflowExecutor)    │
                     │    started    │                        │
                     └───────┬───────┘                        │
                             │ spawn_node reached             │
                             ▼                                │
                     ┌───────────────┐                        │
                     │  in_progress  │  worker_run row open   │
                     └───────┬───────┘                        │
                     ┌───────┴───────┐                        │
                     │               │                        │
                     ▼               ▼                        │
              ┌────────────┐  ┌───────────────┐              │
              │ succeeded  │  │    failed     │              │
              │ (auto-     │  │               │──────────────┘
              │  closed)   │  │ escalate tier │  infra failure
              └────────────┘  │ or auto-block │  (crash_count++)
                              └───────────────┘
```

**Terminal statuses:** `completed`, `closed`, `cancelled`, `rejected`

---

## Worker Spawn

When a workflow run reaches a `spawn_*` node, `processSpawnRequest()` is called:

1. **Capacity gate** — `hasCapacity()`: `active_workers + pending_spawns < DEFAULT_MAX_WORKERS` (5)
2. **Project lock** — one worker per `(project_id, agent_type)` at a time
3. **Dependency gate** — re-queues if any `blocked_by` task is not terminal
4. **Artifact pre-flight** — if `expected_artifacts` already exist, auto-closes without spawning
5. **Compliance gate** — compliance-flagged tasks use local-only model (no cloud fallback)
6. **Escalation** — bumps model tier on repeated failures (`effective_fail_count = spawn_count - crash_count`)
7. **Circuit-breaker model selection** — `chooseHealthyModel(fallbackChain, agentType)`
8. **Spawn count guard** — auto-blocks task if `effective_fail_count ≥ per-type limit` (default 3)

Spawn call routes through the **sink session** (`agent:sink:paw-orchestrator-v2`) so completion announcements don't pollute the main session:

```
POST http://127.0.0.1:{gatewayPort}/tools/invoke
{
  "tool": "sessions_spawn",
  "sessionKey": "agent:sink:paw-orchestrator-v2",
  "args": {
    "task": "<prompt + context_refs + learnings>",
    "agentId": "<agent_type>",
    "model": "<resolved model string>",
    "mode": "run",
    "runTimeoutSeconds": 1800,
    "cwd": "<repo_path if set>"
  }
}
```

A `worker_runs` row is inserted on accepted spawn. The `childSessionKey` is stored in node state for liveness checks.

---

## Concurrency Limits

| Limit | Value | Enforcement |
|---|---|---|
| Max concurrent workers | 5 | `hasCapacity()` checked before every spawn |
| Project+agent lock | 1 worker | `projectHasActiveWorker` + `projectHasPendingSpawn` |
| Spawn count per task | 3 (agent default) | `incrementAndCheckSpawnCount()` |

---

## Worker Results

Workers complete by finishing their session. The orchestrator detects this via:

- **`autoCloseSucceededTasks()`** — scans `active` tasks where the latest `worker_runs.succeeded = 1` and no open runs remain. Runs post-success artifact validation before closing; phantom completions (no output) are flagged `needs_review` in the inbox instead.

---

## Error Handling

| Failure type | Classification | Behavior |
|---|---|---|
| Gateway crash, stall watchdog, ghost orphan | `infra` | Increments `crash_count`; task reset to `not_started`; NOT counted against quality limit |
| Agent error (bad output, tool failure) | `agent_quality` | Increments `spawn_count`; `effective_fail = spawn_count - crash_count` |
| `effective_fail ≥ limit` | auto-block | Task set `work_state='blocked'` with `failure_reason`; inbox alert created |
| Escalation tier advances | model bump | Retries use stronger model tier via `escalationModel()` |
| All models circuit-open | requeue | Spawn skipped; task retried after circuit cooldown |
| Task reaches `HUMAN` escalation tier | abort spawn | Task set `waiting_on`; human must intervene |

---

## Key Files

| File | Responsibility |
|---|---|
| `src/orchestrator/control-loop.ts` | Tick phases, spawn processing |
| `src/orchestrator/scanner.ts` | `findReadyTasks()` eligibility |
| `src/orchestrator/worker-manager.ts` | Capacity, project locks |
| `src/orchestrator/model-chooser.ts` | Tier resolution, fallback chains |
| `src/orchestrator/escalation.ts` | Escalation tier logic |
