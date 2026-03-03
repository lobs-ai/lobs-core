/**
 * Worker manager — track active workers, enforce concurrency limits, project domain locks.
 * Port of lobs-server/app/orchestrator/worker_manager.py
 */

import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { workerRuns, agentStatus as agentStatusTable } from "../db/schema.js";
import { log } from "../util/logger.js";

export const DEFAULT_MAX_WORKERS = 1;

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
  return (countActiveWorkers() + getPendingSpawnCount() + countInFlightTaskRuns()) < maxWorkers;
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
export function projectHasActiveWorker(projectId: string): boolean {
  const db = getDb();
  try {
    const rows = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.projectId, projectId),
        isNull(workerRuns.endedAt),
      ))
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
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(workerRuns).set({
      endedAt: now,
      succeeded: opts.succeeded,
      summary: opts.summary ?? null,
      model: opts.model ?? null,
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      totalTokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
      totalCostUsd: opts.totalCostUsd ?? null,
      durationSeconds: opts.durationSeconds ?? null,
    }).where(eq(workerRuns.workerId, opts.workerId)).run();

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

    db.update(workerRuns).set({
      endedAt: now,
      succeeded: false,
      timeoutReason: reason,
    }).where(eq(workerRuns.workerId, workerId)).run();

    // Reset the associated task back to not_started so it can be retried
    if (taskId) {
      const { getRawDb } = require("../db/connection.js");
      getRawDb().prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ? AND work_state = 'in_progress'`).run(taskId);
      log().warn(`[WORKER_MANAGER] Reset task ${taskId.slice(0, 8)} to not_started after worker termination`);
    }

    log().warn(`[WORKER_MANAGER] Force-terminated worker ${workerId}: ${reason}`);
  } catch (e) {
    log().error(`[WORKER_MANAGER] forceTerminateWorker error: ${e}`);
  }
}

/** In-flight spawn counter — incremented when spawn queued, decremented when spawn completes/fails */
let pendingSpawnCount = 0;
export function incrementPendingSpawns(): void { pendingSpawnCount++; }
export function decrementPendingSpawns(): void { pendingSpawnCount = Math.max(0, pendingSpawnCount - 1); }
export function getPendingSpawnCount(): number { return pendingSpawnCount; }

/** Count workflow runs that are in-flight for tasks (running or pending with a task_id) */
export function countInFlightTaskRuns(): number {
  const { getDb } = require("../db/connection.js");
  const { workflowRuns } = require("../db/schema.js");
  const { inArray, isNotNull, and } = require("drizzle-orm");
  const db = getDb();
  const runs = db.select().from(workflowRuns)
    .where(and(
      inArray(workflowRuns.status, ["running", "pending"]),
      isNotNull(workflowRuns.taskId),
    ))
    .all();
  return runs.length;
}
