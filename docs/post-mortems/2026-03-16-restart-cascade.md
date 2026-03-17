# Post-Mortem: 2026-03-16 Restart Cascade

**Incident date:** 2026-03-16 00:15 – 13:15 EDT  
**Duration:** ~9 hours  
**Severity:** High — service unavailable or degraded for multiple windows; session state lost across multiple active conversations  
**Reported restarts (user-visible):** 5  
**Actual lobs-core process restarts logged:** 14 graceful + 2 fatal crashes  
**Author:** post-mortem agent, 2026-03-17  
**Status:** Root causes confirmed. Mitigations partially shipped (disk-space guard, LM Studio diagnostic). Remaining action items tracked below.

---

## Timeline (All Times UTC-4 / EDT)

| Time | Event |
|------|-------|
| **00:15:33** | ❌ **FATAL #1** — `ENOSPC: no space left on device, write` — lobs-core crashes |
| **00:16:16** | Memory-supervisor detects 117 MB free — defers memory-server start |
| **00:16** – 01:23 | Memory-supervisor retry loop: ~95 health-check failures in ~67 min |
| **01:23:38** | ❌ **FATAL #2** — second `ENOSPC` crash during disk-pressure recovery |
| **01:32** | lobs-core restarts; memory-server still intermittent |
| **01:39** | Graceful restart #1 (agent-triggered: deploy of `e2a050c`) |
| **02:04** | Commit `e2a050c` merged — spawn_agent routing fix |
| **02:49** | Graceful restart #2 (agent-triggered rebuild) |
| **03:16** | Graceful restart #3 (agent-triggered rebuild) |
| **03:20** | Programmer agent `3e3420ae` (strong model) spawned |
| **03:36** | Programmer agent `ff4a93c4` (micro, 120 s) spawned |
| **03:39** | Graceful restart #4 — WORKFLOW_SEED v201; agent `3e3420ae` working on model-validation feature |
| **03:48** | Programmer agent `ab098d20` (strong, 7200 s) spawned — **LM Studio model diagnostic** |
| **04:05** | Graceful restart #5 — WORKFLOW_SEED v202 |
| **04:12** | Graceful restart #6 — WORKFLOW_SEED v203 |
| **04:14** | Programmer agent `795a1297` (standard, 600 s) spawned |
| **04:17** | Workflow `inbox-processing` fires during active restart cycle |
| **04:18** | Graceful restart #7 — WORKFLOW_SEED v204; collision with `scheduled-events` workflow |
| **04:19** | Graceful restart #8 — WORKFLOW_SEED v205; within 60 s of previous |
| **04:24** | Graceful restart #9 — WORKFLOW_SEED v206 |
| **04:25** | Graceful restart #10 — WORKFLOW_SEED v207; channels with active sessions dropped |
| **04:29** | ⚠️ Stale-PID collision — new process starts without prior `PID file removed`; WORKFLOW_SEED v208 |
| **04:35** | Graceful restart #11 — WORKFLOW_SEED v208 re-applied; system stabilises |
| **04:36** | Cloudflared tunnel re-established (tunnelID `5e8ce13d`) |
| **04:36** – 12:21 | System stable ~7.75 hours |
| **12:21** | Graceful restart #12 — morning agent deployment work |
| **13:10:18** | Graceful restart #13 — gateway auth token **not written** before start |
| **13:10:18** – 13:10:42 | 2 rapid graceful restarts; then **11 failed starts** every ~10 s (`Another instance already running`) |
| **13:12:49** – 13:14:15 | `no gateway auth token found` logged every 10 s — gateway misconfigured |
| **13:23** | Final `Another instance` collision storm (PIDs 2259, 12599) — 3 attempts in 30 s |
| **13:46** | System fully recovered, `lobs-core ready` confirmed |

---

## Root Causes

### RC-1: ENOSPC — Disk Exhaustion (Primary, 00:15–01:23)

**Evidence:** Two explicit `[FATAL] Uncaught exception: Error: ENOSPC: no space left on device, write` at 00:15 and 01:23. Memory-supervisor logged `117 MB free` at 00:16 and deferred memory-server start.

**Mechanism:** The filesystem hit 0 free bytes during a write operation in lobs-core's main process (likely the SQLite WAL or a memory-server embedding write). Node.js does not catch `ENOSPC` in its write path — it surfaces as an uncaught exception that terminates the process immediately.

**Contributing factor:** The memory-supervisor entered a **95-failure health-check loop** (01:23–01:32 window) because the memory-server also could not write embeddings. The health check checks HTTP liveness, but the server was crashing on disk writes internally. The 90-second recovery wait meant the loop ran for over an hour instead of backing off.

**Current state:** Disk has since recovered (currently 54 GB free / 228 GB total, 23% used). The memory-supervisor has a low-disk guard (`117 MB` threshold) that skips start, but **there is no ENOSPC handler in lobs-core's main write path**.

---

### RC-2: Agent-Triggered Deploy Loop During Model-Validation Work (Primary, 03:48–04:35)

**Evidence:** WORKFLOW_SEED versions advancing from v201 → v208 across 7 restarts in 47 minutes. Four programmer agents spawned between 03:20–04:14. Each graceful restart includes full WORKFLOW_SEED re-seeding (8–12 workflow definitions), confirming each was triggered by a new binary being started via `lobs start`.

**Mechanism:** The LM Studio model diagnostic implementation work (agents `3e3420ae`, `ab098d20`) followed a **write-compile-restart-test loop** — each iteration requiring `lobs start` to activate the new binary. With 4 agents active concurrently (strong 7200 s, micro 120 s, strong 7200 s, standard 600 s), multiple agents independently decided to restart the service for their test cycle. This produced restarts every 1–7 minutes rather than a single coordinated restart.

**Session-loss impact:** Active Nexus chat sessions (`chat-6a35d5ed`, `chat-9245d5ed`, `chat-b88a4`, `chat-bba7c`, `chat-8a1ea`) were dropped mid-conversation at 04:25. No recovery mechanism exists for in-flight agent tool calls across restarts.

**Contributing factor — stale PID at 04:29:** One restart at 04:25 did not cleanly remove the PID file before the next `lobs start` at 04:29 fired. The new process saw a stale PID but started anyway (lobs-core's startup logic falls through if the PID file's process is not actually running). This created a brief window with ambiguous ownership.

---

### RC-3: Gateway Auth Token Missing on Restart (Secondary, 13:10–13:46)

**Evidence:** `no gateway auth token found — spawn_agent nodes will fail` logged every 10 seconds from 13:10 onward (at least 10 occurrences). The 11 failed starts at 13:10–13:12 (every ~10 s) indicate an external process looping `lobs start` without confirming the prior instance had exited.

**Mechanism:** The gateway auth token is written at runtime from environment or a secrets file. When the 13:10 restart occurred, the token was not available in the new process's environment — either a startup ordering issue (token file not yet written) or an environment variable that did not survive the restart. The retry storm (11 starts in 2 minutes) suggests a supervisor or script was repeatedly attempting `lobs start` as an error-recovery mechanism without a cooldown.

**Impact:** `spawn_agent` was non-functional from 13:10–13:46 (36 minutes). Any task requiring agent spawning during this window would have silently failed at the workflow node.

---

## Why It Looked Like 5 Restarts

The user-visible count of 5 restarts corresponds to the **five distinct service-degradation windows** a user would notice:

1. 00:15 FATAL crash → recovery  
2. 01:23 FATAL crash → recovery  
3. 03:39–04:35 rapid-deploy cluster (felt like one extended outage with dropped sessions)  
4. 12:21 daytime restart  
5. 13:10–13:46 gateway-failure cluster  

The actual process restart count was 14 graceful + 2 fatal = **16 total process starts on March 16**.

---

## Trigger Pattern: Model-Validation Work

The cascade was **not caused** by the model-validation feature itself. The LM Studio diagnostic ADR decisions were sound. The cascade was caused by the **operational pattern** of that work:

1. Multiple strong-model programmer agents spawned concurrently
2. Each agent independently ran `lobs start` as part of its test cycle
3. No inter-agent coordination or restart lock existed
4. The disk exhaustion (RC-1) happened independently at midnight and was a precondition that weakened the system's stability before the morning work began

---

## What Did NOT Cause the Cascade

- **Watchdog / stall detection:** No stall-watchdog events in the log. The orchestrator stall detection was not triggered.
- **Memory leak:** Memory usage was not logged spiking before any crash. The ENOSPC crashes were disk, not RAM.
- **Port conflict:** No port-in-use errors. All restarts acquired ports cleanly.
- **Gateway connectivity:** Cloudflared reconnected at 04:36 and held stable. The 13:10 gateway auth issue was a token-availability problem, not a network problem.
- **Supervisor loop amplification:** The `supervisord` config in paw-hub sets `autorestart=true` for the hub process, but lobs-core runs standalone (not via supervisord), so no external restart amplification occurred.

---

## Gaps in Current Detection

| Gap | Effect observed |
|-----|----------------|
| No ENOSPC handler in write path | Silent crash at midnight, no warning |
| Memory-supervisor health-check loop has no max-restart limit | 95 failed restarts over 67 minutes |
| No inter-agent restart coordination lock | 7 restarts in 47 min during deploy loop |
| No minimum uptime guard before accepting next restart | Back-to-back restarts at 04:18→04:19 (59 s apart) |
| Gateway token not validated at startup | Silent `spawn_agent` failures for 36 min |
| No alerting on restart frequency | No notification until user noticed |
| Stale PID file not cleaned on crash (FATAL path) | Stale-PID collision at 04:29 |

---

## Action Items

### Immediate (this week)

| ID | Action | Owner | Status |
|----|--------|-------|--------|
| AI-01 | Add `ENOSPC` handler to main write path — catch, log CRITICAL, initiate graceful shutdown with disk-full notice rather than uncaught exception | lobs-core | ⬜ open |
| AI-02 | Add restart-frequency telemetry: if > 3 restarts in 10 min, log CRITICAL and hold for 60 s before next start | lobs-core | ⬜ open |
| AI-03 | Add disk-space check to startup health gate: block start if < 200 MB free, log actionable error | lobs-core | ⬜ open |
| AI-04 | Memory-supervisor: cap health-check retry loop at 10 attempts, then back off to 5-min intervals with CRITICAL log | lobs-core | ⬜ open |
| AI-05 | Gateway token: validate presence at startup; log CRITICAL and surface to Nexus status panel if missing | lobs-core | ⬜ open |
| AI-06 | Clean PID file on FATAL crash before process exit (add ENOSPC + uncaught-exception handler that does `fs.unlinkSync(pidFile)`) | lobs-core | ⬜ open |

### Near-term (next 2 weeks)

| ID | Action | Owner | Status |
|----|--------|-------|--------|
| AI-07 | Agent restart coordination: add `lobs restart-lock` advisory file; programmer agents should check before calling `lobs start` | lobs-core + agent templates | ⬜ open |
| AI-08 | Minimum uptime guard: reject `lobs start` if prior instance was alive < 30 s ago (write last-start timestamp) | lobs-core | ⬜ open |
| AI-09 | Disk-usage daily brief inclusion: add `df -h` snapshot to the 06:00 daily brief | lobs-core sentinel | ⬜ open |
| AI-10 | Session recovery on restart: checkpoint in-flight channel state to DB; resume on next start | lobs-core | ⬜ open |

---

## Early-Detection Telemetry (Shipped with this Post-Mortem)

The following telemetry additions are implemented in `src/services/restart-telemetry.ts` (see commit). They provide early warnings before a cascade develops:

- **Restart-frequency counter:** tracks PID-file creation timestamps; alerts CRITICAL if ≥ 3 restarts within any 10-minute window
- **Disk-space probe:** checked at startup and every 10 minutes; WARN at < 500 MB, CRITICAL at < 200 MB
- **Gateway token probe:** checked at startup; CRITICAL log + Nexus status panel badge if missing
- **Memory-supervisor restart counter:** emits CRITICAL after 10 consecutive health-check failures

See `src/services/restart-telemetry.ts` for implementation.

---

## Lessons Learned

1. **Disk exhaustion is a silent killer.** Node's uncaught ENOSPC gives no grace period. Any filesystem write — WAL checkpoint, embedding write, log rotate — can trigger it. Disk monitoring needs to be a first-class startup check, not an afterthought.

2. **Concurrent agents with restart authority is dangerous.** Having multiple long-running programmer agents that each run `lobs start` is operationally equivalent to having multiple operators independently restarting a production service. Coordination is required.

3. **Health-check retry loops need caps.** A retry loop that runs 95 times over 67 minutes is not recovery — it's noise that masks the real problem (disk full) and consumes resources.

4. **Gateway token availability must be a hard startup gate.** Silent `spawn_agent` failure is worse than a startup rejection — it creates invisible task failures that are hard to diagnose.

5. **The user's count of 5 restarts was accurate as a user-experience metric** but the underlying log shows 16 process starts. The gap between user-visible and actual operational events is itself a detection gap.
