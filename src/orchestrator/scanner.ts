/**
 * Task scanner — find tasks ready for workflow dispatch.
 * Port of lobs-server/app/orchestrator/scanner.py
 */

import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { log } from "../util/logger.js";

export interface ReadyTask {
  id: string;
  title: string;
  status: string;
  workState: string;
  agent: string | null;
  projectId: string | null;
  modelTier: string | null;
  notes: string | null;
  escalationTier: number | null;
  retryCount: number | null;
  spawnCount: number | null;
  /** Gateway-crash-orphaned run count. effective_fail = spawnCount - crashCount. */
  crashCount: number | null;
}

/**
 * Check if a task has unresolved blockers.
 * Returns true if any blocker task is not in a terminal state
 * (completed, closed, cancelled, rejected).
 */
function hasUnresolvedBlockers(blockedBy: unknown, db: ReturnType<typeof getDb>): boolean {
  if (!blockedBy) return false;
  let blockerIds: string[];
  try {
    blockerIds = typeof blockedBy === "string" ? JSON.parse(blockedBy) : blockedBy as string[];
  } catch {
    return false;
  }
  if (!Array.isArray(blockerIds) || blockerIds.length === 0) return false;

  // Terminal statuses: task is done/closed/cancelled/rejected
  const TERMINAL_STATUSES = new Set(["completed", "closed", "cancelled", "rejected"]);
  const TERMINAL_WORK_STATES = new Set(["completed", "done"]);

  const blockers = db.select({ id: tasks.id, status: tasks.status, workState: tasks.workState })
    .from(tasks)
    .where(inArray(tasks.id, blockerIds))
    .all();

  for (const blocker of blockers) {
    if (!TERMINAL_STATUSES.has(blocker.status) && !TERMINAL_WORK_STATES.has(blocker.workState ?? "")) {
      return true; // at least one unresolved blocker
    }
  }
  // If a blocker ID doesn't exist in DB, treat it as resolved (deleted = done)
  return false;
}

/**
 * Find tasks that are ready to be dispatched to a workflow.
 *
 * Criteria:
 * - status = "active" (not inbox/completed/rejected)
 * - work_state = "not_started"
 * - has an agent type assigned
 * - no unresolved blockers (blocked_by is null/empty, or all blocker tasks are terminal)
 */
export function findReadyTasks(limit = 10): ReadyTask[] {
  const db = getDb();
  try {
    // Order by agent type to ensure diverse agent selection, not just programmers
    const rows = db.select().from(tasks)
      .where(and(
        eq(tasks.status, "active"),
        eq(tasks.workState, "not_started"),
      ))
      .orderBy(tasks.agent, tasks.updatedAt)
      .all();

    // Filter out tasks with unresolved dependency blockers
    const unblocked = rows.filter(r => {
      if (hasUnresolvedBlockers(r.blockedBy, db)) {
        log().info(`[SCANNER] Skipping task ${r.id} (${r.title}) — has unresolved blockers`);
        return false;
      }
      return true;
    });
    
    // Diversify: round-robin across agent:project combos so no combo starves
    const byCombo = new Map<string, typeof rows>();
    for (const r of unblocked) {
      const key = `${r.agent ?? "unknown"}:${r.projectId ?? "none"}`;
      if (!byCombo.has(key)) byCombo.set(key, []);
      byCombo.get(key)!.push(r);
    }
    const diversified: typeof rows = [];
    let added = true;
    let round = 0;
    while (added && diversified.length < limit) {
      added = false;
      for (const [, comboRows] of byCombo) {
        if (round < comboRows.length && diversified.length < limit) {
          diversified.push(comboRows[round]);
          added = true;
        }
      }
      round++;
    }

    return diversified
      .filter(r => r.agent != null)
      .map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        workState: r.workState ?? "not_started",
        agent: r.agent,
        projectId: r.projectId,
        modelTier: r.modelTier,
        notes: r.notes,
        escalationTier: r.escalationTier,
        retryCount: r.retryCount,
        spawnCount: r.spawnCount,
        crashCount: r.crashCount ?? null,
      }));
  } catch (e) {
    log().error(`[SCANNER] findReadyTasks error: ${e}`);
    return [];
  }
}

/**
 * Find tasks that are blocked and eligible for retry.
 * (work_state = blocked, retry_count < 3)
 * Note: only returns tasks blocked by failure (no blockedBy), not dependency-blocked ones.
 */
export function findRetryableTasks(limit = 5): ReadyTask[] {
  const db = getDb();
  try {
    const rows = db.select().from(tasks)
      .where(and(
        eq(tasks.status, "active"),
        eq(tasks.workState, "blocked"),
      ))
      .limit(limit)
      .all();

    return rows
      .filter(r => r.agent != null && (r.retryCount ?? 0) < 3)
      // Exclude tasks that are dependency-blocked (not failure-blocked)
      .filter(r => !hasUnresolvedBlockers(r.blockedBy, db))
      .map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        workState: r.workState ?? "blocked",
        agent: r.agent,
        projectId: r.projectId,
        modelTier: r.modelTier,
        notes: r.notes,
        escalationTier: r.escalationTier,
        retryCount: r.retryCount,
        spawnCount: r.spawnCount,
        crashCount: r.crashCount ?? null,
      }));
  } catch (e) {
    log().error(`[SCANNER] findRetryableTasks error: ${e}`);
    return [];
  }
}
