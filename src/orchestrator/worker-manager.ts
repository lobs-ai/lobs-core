/**
 * Worker manager — track active workers, enforce concurrency limits, project domain locks.
 * Port of lobs-server/app/orchestrator/worker_manager.py
 */

import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import { getDb, getRawDb } from "../db/connection.js";
import { workerRuns, workflowRuns, agentStatus as agentStatusTable } from "../db/schema.js";
import { log } from "../util/logger.js";
import { recordRunOutcome } from "./model-health.js";
import { discordService } from "../services/discord.js";

export const DEFAULT_MAX_WORKERS = 5;

// ── Failure type classification ───────────────────────────────────────────────

export type FailureType = 'infra' | 'agent_quality';

/**
 * Infrastructure failure reasons — runs that failed due to system events,
 * NOT due to agent logic errors. These should NOT penalise reliability metrics
 * or trigger quality-based retry. crash_count is incremented instead.
 */
const INFRA_TIMEOUT_REASONS = new Set<string>([
  'orphaned on restart',
  'orphaned-on-restart',
  'stale_run_watchdog',
  'stall_watchdog',
  'orchestrator_timeout',
]);

/**
 * Classify a failed worker_run as infrastructure or agent-quality failure.
 *
 * 'infra'         — gateway restart orphan, stale-run watchdog, stall watchdog,
 *                   orchestrator timeout, ghost-run cleanup. NOT an agent bug.
 * 'agent_quality' — deliberate agent failure (bad output, tool error, etc.)
 *
 * @param timeoutReason  The worker_runs.timeout_reason value
 * @param summary        The worker_runs.summary value
 */
export function classifyFailureType(
  timeoutReason: string | null | undefined,
  summary: string | null | undefined,
): FailureType {
  if (timeoutReason && INFRA_TIMEOUT_REASONS.has(timeoutReason)) return 'infra';
  if (summary?.startsWith('ghost:')) return 'infra';
  if (summary?.startsWith('stale_run_watchdog:')) return 'infra';
  if (summary?.startsWith('stall_watchdog:')) return 'infra';
  if (summary === 'session dead — no progress') return 'infra';
  return 'agent_quality';
}

export interface WorkerInfo {
  workerId: string;
  agentType: string | null;
  projectId: string | null;
  startedAt: string | null;
  taskId: string | null;
}

/**
 * Check if a worker slot is available.
 * maxWorkers can be overridden per call.
 */
export function hasCapacity(maxWorkers = DEFAULT_MAX_WORKERS): boolean {
  return (countActiveWorkers() + getPendingSpawnCount()) < maxWorkers;
}

/** Count workers currently running (no endedAt). */
export function countActiveWorkers(): number {
  const db = getDb();
  try {
    const rows = db.select().from(workerRuns)
      .where(and(
        isNull(workerRuns.endedAt),
        // startedAt IS NOT NULL
      ))
      .all();
    // Filter out rows without startedAt
    return rows.filter(r => r.startedAt != null).length;
  } catch (e) {
    log().error(`[WORKER_MANAGER] countActiveWorkers error: ${e}`);
    return 0;
  }
}

/** Get list of currently active workers. */
export function getActiveWorkers(): WorkerInfo[] {
  const db = getDb();
  try {
    const rows = db.select().from(workerRuns)
      .where(isNull(workerRuns.endedAt))
      .all();
    return rows
      .filter(r => r.startedAt != null)
      .map(r => ({
        workerId: r.workerId ?? String(r.id),
        agentType: r.agentType,
        projectId: r.projectId,
        startedAt: r.startedAt,
        taskId: r.taskId,
      }));
  } catch (e) {
    log().error(`[WORKER_MANAGER] getActiveWorkers error: ${e}`);
    return [];
  }
}

/**
 * Check if a project already has an active worker (domain lock).
 * One worker per project at a time.
 */
export function projectHasActiveWorker(projectId: string, agentType?: string): boolean {
  const db = getDb();
  try {
    const conditions = [eq(workerRuns.projectId, projectId), isNull(workerRuns.endedAt)];
    if (agentType) conditions.push(eq(workerRuns.agentType, agentType));
    const rows = db.select().from(workerRuns)
      .where(and(...conditions))
      .all();
    return rows.some(r => r.startedAt != null);
  } catch (e) {
    log().error(`[WORKER_MANAGER] projectHasActiveWorker error: ${e}`);
    return false;
  }
}

/** Mark a worker run as started. */
export function recordWorkerStart(opts: {
  workerId: string;
  agentType: string;
  taskId?: string;
  projectId?: string;
  model?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    log().info(`[WORKER_MANAGER] recordWorkerStart: workerId=${opts.workerId} agent=${opts.agentType} task=${opts.taskId ?? "none"}`);
    db.insert(workerRuns).values({
      workerId: opts.workerId,
      agentType: opts.agentType,
      taskId: opts.taskId ?? null,
      projectId: opts.projectId ?? null,
      model: opts.model ?? null,
      startedAt: now,
    }).run();
    log().info(`[WORKER_MANAGER] workerRuns insert OK`);

    // Update agent status
    db.insert(agentStatusTable)
      .values({
        agentType: opts.agentType,
        status: "busy",
        currentTaskId: opts.taskId ?? null,
        currentProjectId: opts.projectId ?? null,
        lastActiveAt: now,
      })
      .onConflictDoUpdate({
        target: agentStatusTable.agentType,
        set: {
          status: "busy",
          currentTaskId: opts.taskId ?? null,
          currentProjectId: opts.projectId ?? null,
          lastActiveAt: now,
        },
      })
      .run();
  } catch (e) {
    log().error(`[WORKER_MANAGER] recordWorkerStart error: ${e}`);
    log().error(`[WORKER_MANAGER] Stack: ${e instanceof Error ? e.stack : "N/A"}`);
  }
}

/** Mark a worker run as completed. */
export function recordWorkerEnd(opts: {
  workerId: string;
  agentType: string;
  succeeded: boolean;
  taskId?: string;
  summary?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  durationSeconds?: number;
  /**
   * Optional explicit failure classification. When omitted and succeeded=false,
   * failure type is inferred from timeoutReason+summary via classifyFailureType().
   * Callers that know the failure origin should pass this explicitly for accuracy.
   */
  failureType?: FailureType;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    // Determine failure_type for failed runs:
    //   - callers can pass it explicitly (most accurate)
    //   - otherwise infer from summary (timeout_reason not available yet at this point)
    const derivedFailureType: FailureType | null = opts.succeeded
      ? null  // succeeded — no failure type
      : (opts.failureType ?? classifyFailureType(null, opts.summary));

    const updatePayload: Record<string, unknown> = {
      endedAt: now,
      succeeded: opts.succeeded,
      summary: opts.summary ?? null,
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      totalTokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
      totalCostUsd: opts.totalCostUsd ?? null,
      durationSeconds: opts.durationSeconds ?? null,
      failureType: derivedFailureType,
    };
    // Only overwrite model if caller explicitly provides one — preserve the
    // value recorded at spawn time (which has the actual chosen model).
    if (opts.model !== undefined) {
      updatePayload.model = opts.model;
    }
    db.update(workerRuns).set(updatePayload).where(eq(workerRuns.workerId, opts.workerId)).run();

    // Update agent status
    db.insert(agentStatusTable)
      .values({
        agentType: opts.agentType,
        status: "idle",
        currentTaskId: null,
        currentProjectId: null,
        lastActiveAt: now,
        lastCompletedTaskId: opts.taskId ?? null,
        lastCompletedAt: now,
      })
      .onConflictDoUpdate({
        target: agentStatusTable.agentType,
        set: {
          status: "idle",
          currentTaskId: null,
          currentProjectId: null,
          lastActiveAt: now,
          lastCompletedTaskId: opts.taskId ?? null,
          lastCompletedAt: now,
        },
      })
      .run();

    // ── Circuit breaker: record outcome for model health ──────────────────
    if (opts.agentType) {
      // Fetch model from the worker_run row (stored at spawn time)
      const wr = db.select().from(workerRuns).where(eq(workerRuns.workerId, opts.workerId)).get();
      const model = opts.model ?? (wr as any)?.model;
      if (model) {
        // Orphan exclusion: runs that lived >= 60s before being marked failed are likely
        // restart orphans (the agent session was killed by a gateway restart, not a model
        // bug). Don't penalise the model circuit breaker for these.
        // EXCEPTION: orchestrator_timeout and session_dead are genuine failures — always record.
        const durationSec = opts.durationSeconds
          ?? ((wr as any)?.startedAt
              ? (Date.now() - new Date((wr as any).startedAt).getTime()) / 1000
              : null);
        const storedTimeoutReason = (wr as any)?.timeoutReason as string | null | undefined;
        const isGenuineFailure = storedTimeoutReason === "orchestrator_timeout" || storedTimeoutReason === "session_dead";
        const isOrphan = !opts.succeeded && !isGenuineFailure && durationSec != null && durationSec >= 60;
        if (isOrphan) {
          log().info(
            `[WORKER_MANAGER] Skipping circuit-breaker for ${model}/${opts.agentType}: ` +
            `orphan run (duration=${Math.round(durationSec)}s >= 60s, reason=${storedTimeoutReason ?? "none"})`
          );
        } else {
          recordRunOutcome(model, opts.agentType, opts.succeeded, opts.summary ?? '');
        }
      }
    }

    // ── Discord notification ──────────────────────────────────────────────
    if (discordService.isConnected() && opts.taskId) {
      // Fetch task title from DB
      const taskRow = getRawDb().prepare(`SELECT title FROM tasks WHERE id = ?`).get(opts.taskId) as { title: string } | undefined;
      if (taskRow) {
        discordService.notifyCompletion({
          title: taskRow.title,
          agent: opts.agentType,
          succeeded: opts.succeeded,
          summary: opts.summary,
          duration: opts.durationSeconds,
          cost: opts.totalCostUsd,
        }).catch(err => {
          // Fire-and-forget — don't block on Discord failures
          log().debug?.(`[WORKER_MANAGER] Discord notification failed: ${err}`);
        });
      }
    }
  } catch (e) {
    log().error(`[WORKER_MANAGER] recordWorkerEnd error: ${e}`);
  }
}

/**
 * Health check: detect stale workers (running > maxAgeMinutes).
 * Returns list of timed-out worker IDs.
 */
export function detectStaleWorkers(maxAgeMinutes = 120): string[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  try {
    const rows = db.select().from(workerRuns)
      .where(isNull(workerRuns.endedAt))
      .all();
    return rows
      .filter(r => r.startedAt != null && r.startedAt < cutoff)
      .map(r => r.workerId ?? String(r.id));
  } catch (e) {
    log().error(`[WORKER_MANAGER] detectStaleWorkers error: ${e}`);
    return [];
  }
}

/** Force-terminate a stale worker (mark as ended with timeout reason). */
export function forceTerminateWorker(workerId: string, reason = "timeout"): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    // Get the task ID before marking the worker as ended
    const workerRow = db.select().from(workerRuns)
      .where(eq(workerRuns.workerId, workerId))
      .get();
    const taskId = workerRow?.taskId;
    const model = workerRow?.model;
    const agentType = workerRow?.agentType;

    // orchestrator_timeout and all forceTerminate calls are infra failures —
    // they are caused by gateway timeouts, not deliberate agent behaviour.
    const terminateFailureType: FailureType = classifyFailureType(reason, null);
    db.update(workerRuns).set({
      endedAt: now,
      succeeded: false,
      timeoutReason: reason,
      failureType: terminateFailureType,
    }).where(eq(workerRuns.workerId, workerId)).run();

    // Reset the associated task back to not_started so it can be retried
    if (taskId) {

      getRawDb().prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ? AND work_state = 'in_progress'`).run(taskId);
      log().warn(`[WORKER_MANAGER] Reset task ${taskId.slice(0, 8)} to not_started after worker termination`);
    }

    // Feed timeout back into model health circuit breaker
    // Orphan exclusion: if the worker had been running >= 60s it was likely killed by a
    // gateway restart (orphan), not a genuine model failure. Don't open the circuit.
    if (model && agentType) {
      const startedAt = (workerRow as any)?.startedAt;
      const durationSec = startedAt
        ? (Date.now() - new Date(startedAt).getTime()) / 1000
        : null;
      const isOrphan = durationSec != null && durationSec >= 60;
      if (isOrphan) {
        log().info(
          `[WORKER_MANAGER] Skipping circuit-breaker for ${model}/${agentType}: ` +
          `orphan termination (duration=${Math.round(durationSec)}s >= 60s, reason=${reason})`
        );
      } else {
        recordRunOutcome(model, agentType, false, `worker terminated: ${reason}`);
        log().warn(`[WORKER_MANAGER] Recorded failure for circuit breaker: model=${model} agentType=${agentType} reason=${reason}`);
      }
    }

    log().warn(`[WORKER_MANAGER] Force-terminated worker ${workerId}: ${reason}`);
  } catch (e) {
    log().error(`[WORKER_MANAGER] forceTerminateWorker error: ${e}`);
  }
}

/** In-flight spawn counter — incremented when spawn queued, decremented when spawn completes/fails */
let pendingSpawnCount = 0;
const pendingSpawnKeys = new Set<string>();
export function incrementPendingSpawns(projectId?: string, agentType?: string): void {
  pendingSpawnCount++;
  if (projectId) pendingSpawnKeys.add(agentType ? `${projectId}:${agentType}` : projectId);
}
export function decrementPendingSpawns(projectId?: string, agentType?: string): void {
  pendingSpawnCount = Math.max(0, pendingSpawnCount - 1);
  if (projectId) pendingSpawnKeys.delete(agentType ? `${projectId}:${agentType}` : projectId);
}
export function getPendingSpawnCount(): number { return pendingSpawnCount; }
export function projectHasPendingSpawn(projectId: string, agentType?: string): boolean {
  if (agentType) return pendingSpawnKeys.has(`${projectId}:${agentType}`);
  // fallback: check if any key starts with projectId
  for (const k of pendingSpawnKeys) { if (k.startsWith(projectId)) return true; }
  return false;
}

/** Count workflow runs that are in-flight for tasks (running or pending with a task_id) */
export function countInFlightTaskRuns(): number {



  const db = getDb();
  const runs = db.select().from(workflowRuns)
    .where(and(
      inArray(workflowRuns.status, ["running", "pending"]),
      isNotNull(workflowRuns.taskId),
    ))
    .all();
  return runs.length;
}
