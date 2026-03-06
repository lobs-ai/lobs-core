/**
 * Orchestrator control loop — main scan/dispatch service.
 *
 * On each tick:
 * 1. Advance active workflow runs (one step per run)
 * 1b. Process pending spawn requests (drain queue → gateway /tools/invoke)
 * 2. Process workflow events (event-triggered workflows)
 * 3. Process schedule triggers (cron-triggered workflows)
 * 4. Scan for new ready tasks → match to workflows → start runs
 * 5. Health check active workers (detect stale)
 * 6. Worker health check (legacy)
 * 7. Auto-close active tasks whose every worker_run shows succeeded=true
 *
 * Spawns route through the "sink" agent session so completion announcements
 * don't pollute the main session.
 */

import { readFileSync, existsSync } from "node:fs";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { eq, and } from "drizzle-orm";
import { log } from "../util/logger.js";
import { processPendingResumes } from "../index.js";
import { WorkflowExecutor } from "../workflow/engine.js";
import { popPendingSpawns, requeueSpawn, type SpawnRequest } from "../workflow/nodes.js";
import { getDb, getRawDb } from "../db/connection.js";
import { workflowRuns, tasks as tasksTable } from "../db/schema.js";
import { maybeFlushTriageQueue } from "./triage.js";
import { buildTaskContext } from "../util/task-context.js";
import { findReadyTasks } from "./scanner.js";
import {
  hasCapacity,
  projectHasActiveWorker,
  projectHasPendingSpawn,
  recordWorkerStart,
  recordWorkerEnd,
  incrementPendingSpawns,
  decrementPendingSpawns,
  detectStaleWorkers,
  forceTerminateWorker,
} from "./worker-manager.js";
import { chooseModel, resolveTaskTier, TIER_MODELS, buildFallbackChain } from "./model-chooser.js";
import { chooseHealthyModel, seedModelHealthFromHistory } from "./model-health.js";

let timer: ReturnType<typeof setInterval> | null = null;
let executor: WorkflowExecutor | null = null;
let gatewayPort: number = 18789;
let gatewayToken: string = "";

export function getGatewayConfig(): { port: number; token: string } {
  return { port: gatewayPort, token: gatewayToken };
}
let isFirstTick = true;


/** Session key for the sink agent — spawns route here to avoid polluting main */
const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";


/**
 * Check if a worker session is still alive and making progress.
 * Returns true if the session exists AND has been updated in the last 5 minutes.
 * This allows slow local models to run as long as they're making progress,
 * while detecting dead sessions that stopped advancing.
 */
async function checkSessionAlive(sessionKey: string): Promise<boolean> {
  try {
    // Strategy: check the transcript file directly instead of relying on sessions_list,
    // which can miss ephemeral subagent sessions after store cleanup.

    // Extract agent id from session key (e.g. "agent:programmer:subagent:UUID" → "programmer")
    const parts = sessionKey.split(":");
    const agentId = parts[1] ?? "main";
    // Extract session UUID — the last UUID-like segment
    const uuidMatch = sessionKey.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

    // Try to find the session in the agent's session store
    const storePath = `${process.env.HOME}/.openclaw/agents/${agentId}/sessions/sessions.json`;
    try {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const entry = store[sessionKey];
      if (entry) {
        const updatedAt = entry.updatedAt as number;
        const ageMs = Date.now() - updatedAt;
        const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — matches runTimeoutSeconds
        if (ageMs <= STALE_THRESHOLD_MS) return true;
        // Entry exists but stale — check transcript file mtime as backup
      }
    } catch {}

    // Fallback: check if transcript file exists and was recently modified
    if (uuidMatch) {
      const transcriptDir = `${process.env.HOME}/.openclaw/agents/${agentId}/sessions`;
      const transcriptPath = `${transcriptDir}/${uuidMatch[1]}.jsonl`;
      try {
        const { statSync } = require("node:fs");
        const stat = statSync(transcriptPath);
        const fileAgeMs = Date.now() - stat.mtimeMs;
        const FILE_STALE_MS = 15 * 60 * 1000; // 15 min — matches runTimeoutSeconds
        if (fileAgeMs <= FILE_STALE_MS) return true;
        log().debug?.("checkSessionAlive: transcript " + transcriptPath.slice(-50) + " stale (" + Math.round(fileAgeMs / 60000) + "min)");
        return false;
      } catch {
        // No transcript file — session truly doesn't exist
        return false;
      }
    }

    // Can't determine — assume alive
    return true;
  } catch {
    return true; // assume alive on error
  }
}

export function startControlLoop(ctx: OpenClawPluginServiceContext, intervalMs: number): void {
  log().info(`orchestrator: starting control loop (interval=${intervalMs}ms)`);

  executor = new WorkflowExecutor();

  // Read gateway config for spawn API calls
  try {
    const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gatewayPort = cfg?.gateway?.port ?? 18789;
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
    if (gatewayToken) {
      log().info(`orchestrator: gateway spawn API configured (port=${gatewayPort})`);
    } else {
      log().warn("orchestrator: no gateway auth token found — spawn_agent nodes will fail");
    }
  } catch (e) {
    log().warn(`orchestrator: could not read gateway config: ${e}`);
  }

  // Backfill model_health from recent worker_runs on startup (Phase 4)
  // Seeds total_runs/total_failures from last 24h so circuit breaker has
  // accurate history after restarts. Only touches rows that do not exist yet.
  seedModelHealthFromHistory(24);

  const tick = () => {
    try {
      runTick();
    } catch (err) {
      log().error(`orchestrator: tick failed: ${String(err)}`);
    }
  };

  void tick();
  timer = setInterval(tick, intervalMs);
}

export function stopControlLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log().info("orchestrator: control loop stopped");
  }
}

function runTick(): void {
  if (!executor) return;

  // On first tick, resume any in-flight workers from before restart
  if (isFirstTick) {
    isFirstTick = false;
    processPendingResumes().catch(e => log().warn(`paw: processPendingResumes error: ${e}`));
  }

  // ── 1. Advance active runs ─────────────────────────────────────────────────
  try {
    const activeRuns = executor.getActiveRuns(20);
    let advanced = 0;
    for (const run of activeRuns) {
      // Keep advancing until the run blocks (waiting for spawn, delay, etc.)
      let passes = 0;
      while (passes < 5) {
        const didWork = executor.advance(run);
        if (!didWork) break;
        passes++;
        advanced++;
        // Re-fetch run state for next iteration
        const updated = executor.getActiveRuns(1).find(r => r.id === run.id) ?? null;
        if (!updated || updated.status !== "running") break;
        Object.assign(run, updated);
      }
    }
    if (advanced > 0) {
      log().debug?.(`orchestrator: advanced ${advanced}/${activeRuns.length} runs`);
    }
  } catch (e) {
    log().error(`orchestrator: advance phase error: ${e}`);
  }

  // ── 1b. Process pending spawn requests ─────────────────────────────────────
  try {
    const spawns = popPendingSpawns();
    for (const req of spawns) {
      const spawnProjectId = (((req.context?.task ?? {}) as Record<string, unknown>)["project_id"] ?? ((req.context?.task ?? {}) as Record<string, unknown>)["projectId"] ?? ((req.context?.project ?? {}) as Record<string, unknown>)["id"]) as string | undefined;

      // Capacity gate: re-queue if at max workers
      if (!hasCapacity()) {
        log().info(`orchestrator: at capacity — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      // Project lock: one worker per project per agent type
      if (spawnProjectId && (projectHasActiveWorker(spawnProjectId, req.agentType) || projectHasPendingSpawn(spawnProjectId, req.agentType))) {
        log().debug?.(`orchestrator: project ${spawnProjectId.slice(0, 8)}:${req.agentType} locked — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      incrementPendingSpawns(spawnProjectId, req.agentType);
      processSpawnRequest(req).catch((err) => {
        log().error(`orchestrator: spawn failed for run ${req.runId.slice(0, 8)}: ${err}`);
        decrementPendingSpawns(spawnProjectId, req.agentType);
        writeSpawnResult(req.runId, req.nodeId, {
          status: "failed",
          error: String(err),
        });
      });
    }
  } catch (e) {
    log().error(`orchestrator: spawn processing error: ${e}`);
  }

  // ── 2. Process workflow events ─────────────────────────────────────────────
  try {
    const started = executor.processEvents(10);
    if (started > 0) {
      log().info(`orchestrator: started ${started} event-triggered runs`);
    }
  } catch (e) {
    log().error(`orchestrator: processEvents error: ${e}`);
  }

  // ── 3. Process schedules ───────────────────────────────────────────────────
  try {
    const started = executor.processSchedules();
    if (started > 0) {
      log().info(`orchestrator: started ${started} schedule-triggered runs`);
    }
  } catch (e) {
    log().error(`orchestrator: processSchedules error: ${e}`);
  }

  // ── 4. Scan for ready tasks ────────────────────────────────────────────────
  try {
    if (hasCapacity()) {
      const readyTasks = findReadyTasks(5);
      for (const task of readyTasks) {
        if (!hasCapacity()) break;



        if (task.projectId && task.agent && (projectHasActiveWorker(task.projectId, task.agent) || projectHasPendingSpawn(task.projectId, task.agent))) {
          log().debug?.(`orchestrator: project ${task.projectId.slice(0, 8)}:${task.agent} locked — skipping task ${task.id.slice(0, 8)}`);
          continue;
        }

        const taskObj = { ...task };
        const workflow = executor.matchWorkflow(taskObj);
        if (workflow) {
          executor.startRun(workflow, {
            task: taskObj,
            triggerType: "task_match",
          });
          log().info(`orchestrator: started workflow '${workflow.name}' for task ${task.id.slice(0, 8)} (${task.title.slice(0, 40)})`);
        } else {
          log().debug?.(`orchestrator: no workflow matched for task ${task.id.slice(0, 8)} (agent=${task.agent})`);
        }
      }
    }
  } catch (e) {
    log().error(`orchestrator: scan phase error: ${e}`);
  }

  // ── 5a. Worker liveness check (progress-based) ─────────────────────────────
  // Check worker_runs with no ended_at — if session is dead, mark failed.
  try {
    const liveDb = getDb();
    const { workerRuns: wrTable } = require("../db/schema.js");
    const { isNull } = require("drizzle-orm");
    const openWorkers = liveDb.select().from(wrTable).where(isNull(wrTable.endedAt)).all();
    for (const w of openWorkers) {
      const sessionKey = w.workerId;
      if (!sessionKey) continue;
      const runningMin = (Date.now() - new Date(w.startedAt).getTime()) / 60000;
      if (runningMin < 12) continue; // give workers time — long model calls can take 5-10min

      checkSessionAlive(sessionKey).then((alive: boolean) => {
        if (!alive) {
          log().warn("orchestrator: worker " + w.id + " (" + w.agentType + ") session dead after " + Math.round(runningMin) + "min — marking failed");
          recordWorkerEnd({ workerId: sessionKey, agentType: w.agentType, succeeded: false, summary: "session dead — no progress" });
        }
      }).catch(() => {});
    }
  } catch (e) {
    log().error("orchestrator: worker liveness error: " + String(e));
  }

  // ── 5b. Stale workflow run cleanup (progress-based) ────────────────────────
  // Cancel workflow runs stuck too long. Thresholds:
  //   - spawn nodes with NO session: 2 min (spawn takes seconds; silence = dropped)
  //   - spawn nodes WITH session but session is dead: 3 min (fast recovery after drain)
  //   - spawn nodes WITH session and session is alive: reset clock (worker may be slow but ok)
  //   - all other nodes: 10 min
  try {
    const staleDb = getDb();
    const staleThreshold10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleThreshold3  = new Date(Date.now() -  8 * 60 * 1000).toISOString();
    const staleThreshold2  = new Date(Date.now() -  2 * 60 * 1000).toISOString();
    const staleRuns = staleDb.select().from(workflowRuns)
      .where(and(eq(workflowRuns.status, "running")))
      .all()
      .filter((r: any) => r.updatedAt && r.updatedAt < staleThreshold2);

    for (const run of staleRuns) {
      const nodeStates = (run.nodeStates ?? {}) as Record<string, any>;
      const currentNs = nodeStates[run.currentNode ?? ""] ?? {};
      const childKey = currentNs["childSessionKey"] as string | undefined;
      const isSpawnNode = !!run.currentNode?.startsWith("spawn_");

      if (isSpawnNode && childKey) {
        // Spawn node with a session key recorded.
        // After 3 min: check if session is actually alive. If dead (e.g. killed during drain),
        // fail immediately and clean up the dangling workerRuns row to free capacity.
        // If alive, touch updatedAt so we don't re-check every tick.
        if (run.updatedAt < staleThreshold3) {
          checkSessionAlive(childKey).then((alive: boolean) => {
            if (alive) {
              // Session is live — reset staleness clock so we don't spam liveness checks
              staleDb.update(workflowRuns).set({ updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
            } else {
              // Session is dead — fail the workflow run and free the capacity slot
              staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
              const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
              log().warn("orchestrator: failed stale spawn run " + run.id.slice(0, 8) + " — worker session " + childKey.slice(0, 30) + " gone after " + mins + "min (possible drain)");
              // Clean up dangling workerRuns row so capacity is freed and circuit breaker fires
              try {
                const { workerRuns: wrTable } = require("../db/schema.js");
                const wrRow = staleDb.select().from(wrTable).where(eq(wrTable.workerId, childKey)).get() as any;
                recordWorkerEnd({
                  workerId: childKey,
                  agentType: wrRow?.agentType ?? "unknown",
                  succeeded: false,
                  summary: `session_dead: stale after ${mins}min`,
                });
              } catch {}
            }
          }).catch(() => {});
        }
      } else if (isSpawnNode && !childKey) {
        // Spawn node with NO session after 2 min — spawn was silently dropped (e.g. gateway drain)
        staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
        const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
        log().warn("orchestrator: failed stale spawn run " + run.id.slice(0, 8) + " (node=" + run.currentNode + ", no session, stuck " + mins + "min) — spawn was dropped");
      } else if (!isSpawnNode && run.updatedAt < staleThreshold10) {
        // Non-spawn node stuck >10 min — fail it
        staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
        const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
        log().warn("orchestrator: failed stale run " + run.id.slice(0, 8) + " (node=" + run.currentNode + ", stuck >" + mins + "min)");
      }
    }
  } catch (e) {
    log().error("orchestrator: stale workflow cleanup error: " + String(e));
  }

  // ── 5c. Triage queue flush ────────────────────────────────────────────────
  maybeFlushTriageQueue().catch(e => log().error(`orchestrator: triage flush error: ${e}`));

  // ── 6. Worker health check (legacy) ───────────────────────────────────────
  try {
    const staleWorkers = detectStaleWorkers(120);
    for (const workerId of staleWorkers) {
      log().warn(`orchestrator: force-terminating stale worker ${workerId}`);
      forceTerminateWorker(workerId, "orchestrator_timeout");
    }
  } catch (e) {
    log().error(`orchestrator: health check error: ${e}`);
  }

  // ── 7. Auto-close tasks where all worker_runs succeeded ────────────────────
  // Detects active tasks where every worker_run has succeeded=1 (at least one
  // run exists, no failed or in-flight runs). Marks them completed and logs an
  // audit event so the orchestrator stops re-queuing them.
  try {
    autoCloseSucceededTasks();
  } catch (e) {
    log().error(`orchestrator: auto-close succeeded tasks error: ${e}`);
  }

  // ── 8. Watchdog: close ghost worker_runs ────────────────────────────────────
  // Closes worker_runs where ended_at IS NULL and started_at < now - 5 min.
  // These are "ghost" runs left by sessions that died before writing ended_at.
  // The 5-min buffer is safe: real runs complete in <3min; anything older with
  // a dead session is a ghost inflating the capacity counter.
  try {
    runWatchdog();
  } catch (e) {
    log().error(`orchestrator: watchdog error: ${e}`);
  }
}

// ── Watchdog: ghost worker_run cleanup ────────────────────────────────────────

/**
 * Scan for worker_runs with ended_at IS NULL and started_at older than 5 minutes.
 * For each, check if the session is still alive. If not (or if no session key),
 * close the run as a ghost, reset the task to not_started, and fail any workflow_run
 * stuck at a spawn node for that task.
 *
 * Safe on every tick (query is cheap and idempotent).
 */
function runWatchdog(): void {
  const db = getRawDb();
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const ghostCandidates = db.prepare(`
    SELECT id, worker_id, task_id, agent_type, started_at
    FROM worker_runs
    WHERE ended_at IS NULL
      AND started_at IS NOT NULL
      AND started_at < ?
  `).all(cutoff) as Array<{
    id: number;
    worker_id: string | null;
    task_id: string | null;
    agent_type: string | null;
    started_at: string;
  }>;

  if (ghostCandidates.length === 0) return;

  const now = new Date().toISOString();
  log().debug?.(`[WATCHDOG] ${ghostCandidates.length} worker_run(s) >5min with null ended_at — checking liveness`);

  for (const wr of ghostCandidates) {
    const sessionKey = wr.worker_id;
    if (sessionKey) {
      checkSessionAlive(sessionKey).then((alive: boolean) => {
        if (alive) {
          log().debug?.(`[WATCHDOG] worker_run ${wr.id} session ${sessionKey.slice(0, 30)} still alive — skipping`);
          return;
        }
        closeGhostRun(wr, now);
      }).catch(() => {
        // On error checking session, close conservatively
        closeGhostRun(wr, now);
      });
    } else {
      // No session key recorded — definitely orphaned
      closeGhostRun(wr, now);
    }
  }
}

type GhostRunRow = {
  id: number;
  worker_id: string | null;
  task_id: string | null;
  agent_type: string | null;
  started_at: string;
};

function closeGhostRun(wr: GhostRunRow, now: string): void {
  const db = getRawDb();
  const staleMin = Math.round((Date.now() - new Date(wr.started_at).getTime()) / 60000);

  // 1. Close the worker_run
  const changed = db.prepare(`
    UPDATE worker_runs
    SET ended_at = ?, succeeded = 0, summary = 'ghost: watchdog closed stale run'
    WHERE id = ? AND ended_at IS NULL
  `).run(now, wr.id);

  if ((changed as { changes: number }).changes === 0) return; // already closed by another path

  log().warn(`[WATCHDOG] Closed ghost worker_run ${wr.id} (${wr.agent_type ?? "?"}) — stale ${staleMin}min, session=${wr.worker_id?.slice(0, 30) ?? "none"}`);

  // 2. Reset task to not_started if still in_progress
  if (wr.task_id) {
    db.prepare(`
      UPDATE tasks
      SET work_state = 'not_started', spawn_count = 0, updated_at = ?
      WHERE id = ? AND work_state = 'in_progress'
    `).run(now, wr.task_id);
  }

  // 3. Fail workflow_runs stuck at a spawn node for this task
  if (wr.task_id) {
    try {
      const liveDb = getDb();
      const stuckRuns = liveDb.select().from(workflowRuns)
        .where(and(eq(workflowRuns.status, "running"), eq(workflowRuns.taskId, wr.task_id)))
        .all()
        .filter((r: any) => r.currentNode?.startsWith("spawn_"));

      for (const run of stuckRuns) {
        liveDb.update(workflowRuns)
          .set({ status: "failed", updatedAt: now })
          .where(eq(workflowRuns.id, run.id))
          .run();
        log().warn(`[WATCHDOG] Failed workflow_run ${run.id.slice(0, 8)} stuck at ${run.currentNode} (ghost task ${wr.task_id.slice(0, 8)})`);
      }
    } catch (e) {
      log().error(`[WATCHDOG] workflow_run cleanup error for task ${wr.task_id}: ${e}`);
    }
  }
}

// ── Auto-close helper ─────────────────────────────────────────────────────────

/**
 * Close any active task whose worker_runs are ALL succeeded=1.
 *
 * Safe to call on every tick (query is cheap; idempotent).
 * Writes a control_loop_events row per closed task for audit trail.
 */
function autoCloseSucceededTasks(): void {
  const db = getRawDb();

  const stale = db.prepare(`
    SELECT
        t.id,
        t.title,
        t.agent,
        COUNT(wr.id)                                          AS run_count,
        SUM(CASE WHEN wr.succeeded = 1 THEN 1 ELSE 0 END)    AS succeeded_count,
        SUM(CASE WHEN wr.succeeded = 0 THEN 1 ELSE 0 END)    AS failed_count,
        SUM(CASE WHEN wr.succeeded IS NULL THEN 1 ELSE 0 END) AS pending_count,
        MAX(wr.ended_at)                                      AS last_run_at
    FROM tasks t
    JOIN worker_runs wr ON wr.task_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id
    HAVING
        run_count > 0
        AND succeeded_count = run_count
        AND failed_count = 0
        AND pending_count = 0
    ORDER BY last_run_at ASC
  `).all() as Array<{
    id: string;
    title: string;
    agent: string;
    run_count: number;
    last_run_at: string;
  }>;

  if (stale.length === 0) return;

  const now = new Date().toISOString();

  const closeStmt = db.prepare(`
    UPDATE tasks
    SET status = 'completed',
        finished_at = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const eventStmt = db.prepare(`
    INSERT INTO control_loop_events (id, event_type, status, payload, created_at)
    VALUES (lower(hex(randomblob(16))), 'auto_close_succeeded', 'processed', json(?), ?)
  `);

  for (const task of stale) {
    closeStmt.run(now, now, task.id);
    eventStmt.run(
      JSON.stringify({
        task_id: task.id,
        title: task.title,
        agent: task.agent,
        run_count: task.run_count,
        last_run_at: task.last_run_at,
        reason: "all_worker_runs_succeeded",
        closed_at: now,
      }),
      now,
    );
    log().info(
      `[AUTO-CLOSE] Completed task ${task.id.slice(0, 8)} (${task.agent}): ` +
      `"${task.title.slice(0, 60)}" — ${task.run_count} run(s) all succeeded`,
    );
  }
}

// ── Spawn processing ─────────────────────────────────────────────────────────

const SPAWN_COUNT_LIMIT = 3;

/**
 * Per-task-type spawn count limits. Override the default (SPAWN_COUNT_LIMIT=3) for specific task types.
 * Task types not listed here fall back to SPAWN_COUNT_LIMIT.
 *
 * Rationale:
 *   "bug":     4  — bugs may need an extra retry after initial reproduction
 *   "feature": 5  — features can legitimately need multiple coding passes
 *   "spike":   2  — investigative tasks should resolve quickly
 *   "chore":   3  — default; maintenance tasks rarely need many retries
 *   "other":   3  — default fallback
 */
const SPAWN_COUNT_LIMIT_BY_TYPE: Record<string, number> = {
  bug: 4,
  feature: 5,
  spike: 2,
  chore: 3,
  other: 3,
};

function spawnCountLimitForType(taskType: string | null | undefined): number {
  if (taskType && taskType in SPAWN_COUNT_LIMIT_BY_TYPE) {
    return SPAWN_COUNT_LIMIT_BY_TYPE[taskType];
  }
  return SPAWN_COUNT_LIMIT;
}

/**
 * Increment spawn_count for a task and check if it has exceeded the per-type limit.
 * Returns true if task was auto-blocked (spawn_count >= limit after increment).
 * The limit is determined by the task's task_type (falls back to SPAWN_COUNT_LIMIT=3).
 */
function incrementAndCheckSpawnCount(taskId: string): boolean {
  const db = getDb();
  try {
    const task = db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
    if (!task) return false;

    const limit = spawnCountLimitForType(task.shape);
    const newCount = (task.spawnCount ?? 0) + 1;
    db.update(tasksTable).set({
      spawnCount: newCount,
      updatedAt: new Date().toISOString(),
    }).where(eq(tasksTable.id, taskId)).run();

    if (newCount >= limit) {
      // Auto-block the task to stop runaway spawning
      db.update(tasksTable).set({
        workState: "blocked",
        failureReason: `Auto-blocked: spawn_count reached ${newCount} (limit=${limit}, type=${task.shape ?? "other"}). Needs human review.`,
        updatedAt: new Date().toISOString(),
      }).where(eq(tasksTable.id, taskId)).run();

      log().warn(
        `[SPAWN_GUARD] Task ${taskId.slice(0, 8)} auto-blocked — spawn_count=${newCount} >= limit=${limit} (type=${task.shape ?? "other"})`
      );
      return true;
    }
    log().debug?.(`[SPAWN_GUARD] Task ${taskId.slice(0, 8)} spawn_count now ${newCount}/${limit} (type=${task.shape ?? "other"})`);
    return false;
  } catch (e) {
    log().error(`[SPAWN_GUARD] incrementAndCheckSpawnCount error: ${e}`);
    return false;
  }
}

async function processSpawnRequest(req: SpawnRequest): Promise<void> {
  if (!gatewayToken) {
    throw new Error("No gateway auth token configured — cannot spawn agents");
  }

  const taskCtx = (req.context?.task ?? {}) as Record<string, unknown>;
  const projectCtx = (req.context?.project ?? {}) as Record<string, unknown>;
  const taskTitle = (taskCtx["title"] as string) ?? "Workflow task";
  const taskNotes = (taskCtx["notes"] as string) ?? "";
  // Load context_refs files if specified
  const contextRefs = (taskCtx["context_refs"] ?? taskCtx["contextRefs"] ?? []) as string[];
  let contextBlock = "";
  if (Array.isArray(contextRefs) && contextRefs.length > 0) {
    const loaded: string[] = [];
    for (const ref of contextRefs) {
      const resolved = ref.replace(/^~/, process.env.HOME ?? "");
      if (existsSync(resolved)) {
        try {
          const content = readFileSync(resolved, "utf-8").trim();
          if (content.length > 0) {
            loaded.push(`### File: ${ref}\n${content.slice(0, 30000)}`);
          }
        } catch {}
      }
    }
    if (loaded.length > 0) {
      contextBlock = "\n\n---\n## Reference Context\n" + loaded.join("\n\n") + "\n---\n";
    }
  }
  const taskPrompt = req.promptTemplate ?? `${taskTitle}\n\n${taskNotes}`.trim();
  const repoPath = (projectCtx["repo_path"] as string) || undefined;
  const gitReminder = (req.agentType === "programmer" || req.agentType === "architect") && repoPath
    ? `\n\n⚠️ IMPORTANT: When you are done, you MUST run: git add -A && git commit -m "agent(${req.agentType}): <brief summary>"\nDo NOT finish without committing your changes.`
    : "";
  const taskContext = buildTaskContext({ projectId: (taskCtx["project_id"] as string) ?? undefined, agentType: req.agentType });
  const finalPrompt = taskPrompt + contextBlock + gitReminder + taskContext;

  // ── Circuit-breaker-aware model selection ────────────────────────────────
  const modelChoice = req.modelTier
    ? chooseModel(req.modelTier, req.agentType)
    : chooseModel("standard", req.agentType);

  // Build fallback chain: uses AGENT_FALLBACK_CHAINS if available, else tier-level alternatives
  const primaryModel = modelChoice.model;
  const fallbackChain = buildFallbackChain(primaryModel, modelChoice.tier, req.agentType);

  const { model, degraded: circuitDegraded } = req.agentType
    ? chooseHealthyModel(fallbackChain, req.agentType)
    : { model: primaryModel, degraded: false };

  if (circuitDegraded) {
    // Design doc: do NOT dispatch when all models are open — leave task queued so it retries
    // after the cooldown expires.
    log().error(
      `[SPAWN] ⚠️  All models circuit-open for ${req.agentType} ` +
      `(chain=${fallbackChain.join(", ")}). Blocking dispatch — task will requeue after cooldown.`
    );
    decrementPendingSpawns(
      (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined,
      req.agentType
    );
    writeSpawnResult(req.runId, req.nodeId, {
      status: "failed",
      error: `all_models_unhealthy: all circuit breakers open for ${req.agentType}. Task requeued — will retry after cooldown expires.`,
    });
    return;
  }

  // ── Spawn count guard ────────────────────────────────────────────────────
  if (req.taskId) {
    const autoBlocked = incrementAndCheckSpawnCount(req.taskId);
    if (autoBlocked) {
      decrementPendingSpawns(
        (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined,
        req.agentType
      );
      writeSpawnResult(req.runId, req.nodeId, {
        status: "failed",
        error: `Task auto-blocked: spawn_count exceeded per-type limit (see task failure_reason for details)`,
      });
      return;
    }
  }

  log().info(
    `[SPAWN] Spawning ${req.agentType} for run ${req.runId.slice(0, 8)} ` +
    `(task=${req.taskId?.slice(0, 8) ?? "none"}, model=${model})`
  );

  // Route through sink session so completions don't pollute main
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      tool: "sessions_spawn",
      sessionKey: SINK_SESSION_KEY,
      args: {
        task: finalPrompt,
        agentId: req.agentType,
        model,
        mode: "run",
        cleanup: "keep",
        runTimeoutSeconds: 900,
        ...(repoPath ? { cwd: repoPath } : {}),
      },
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.ok) {
    const err = (data.error as Record<string, unknown>)?.message ?? JSON.stringify(data.error);
    const workerProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
    decrementPendingSpawns(workerProjectId, req.agentType);
    throw new Error(`Gateway spawn failed: ${err}`);
  }

  const details = (data.result as Record<string, unknown>)?.details as Record<string, unknown> | undefined;
  const childSessionKey = (details?.childSessionKey as string) ?? undefined;
  const status = (details?.status as string) ?? "unknown";

  if (status === "accepted" && childSessionKey) {
    log().info(`[SPAWN] Accepted: session=${childSessionKey} run=${req.runId.slice(0, 8)}`);

    const workerProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
    recordWorkerStart({
      workerId: childSessionKey,
      agentType: req.agentType,
      taskId: req.taskId,
      projectId: workerProjectId,
      model,
    });

    decrementPendingSpawns(workerProjectId, req.agentType);
    writeSpawnResult(req.runId, req.nodeId, {
      childSessionKey,
    });
  } else {
    decrementPendingSpawns((taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined, req.agentType);
    throw new Error(`Spawn returned status=${status}: ${JSON.stringify(details)}`);
  }
}

function writeSpawnResult(
  runId: string,
  nodeId: string,
  update: Record<string, unknown>,
): void {
  const db = getDb();
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  if (!run) {
    log().error(`[SPAWN] Cannot write result: run ${runId} not found`);
    return;
  }

  const nodeStates = (run.nodeStates as Record<string, Record<string, unknown>>) ?? {};
  const ns = nodeStates[nodeId] ?? {};

  if (update["childSessionKey"]) {
    ns["childSessionKey"] = update["childSessionKey"];
  }
  if (update["status"] === "failed") {
    ns["spawn_result"] = { status: "failed", error: update["error"] };
  }

  nodeStates[nodeId] = ns;
  db.update(workflowRuns).set({
    nodeStates,
    updatedAt: new Date().toISOString(),
  }).where(eq(workflowRuns.id, runId)).run();
}
