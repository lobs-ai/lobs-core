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
}

/**
 * Find tasks that are ready to be dispatched to a workflow.
 *
 * Criteria:
 * - status = "active" (not inbox/completed/rejected)
 * - work_state = "not_started"
 * - has an agent type assigned
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
    
    // Diversify: pick up to limit tasks, prioritizing one per agent type first
    const byAgent = new Map<string, typeof rows>();
    for (const r of rows) {
      const a = r.agent ?? "unknown";
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a)!.push(r);
    }
    const diversified: typeof rows = [];
    // Round-robin across agent types
    let added = true;
    let round = 0;
    while (added && diversified.length < limit) {
      added = false;
      for (const [, agentRows] of byAgent) {
        if (round < agentRows.length && diversified.length < limit) {
          diversified.push(agentRows[round]);
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
      }));
  } catch (e) {
    log().error(`[SCANNER] findReadyTasks error: ${e}`);
    return [];
  }
}

/**
 * Find tasks that are blocked and eligible for retry.
 * (work_state = blocked, retry_count < 3)
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
      }));
  } catch (e) {
    log().error(`[SCANNER] findRetryableTasks error: ${e}`);
    return [];
  }
}
