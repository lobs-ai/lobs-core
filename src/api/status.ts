import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, inArray, isNull, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, workerRuns, workflowRuns, inboxItems, modelUsageEvents } from "../db/schema.js";
import { json, error } from "./index.js";
import { execSync } from "node:child_process";

export async function handleStatusRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  _parts: string[] = [],
): Promise<void> {
  const db = getDb();

  if (sub === "overview") {
    const openTasks = db.select().from(tasks).where(inArray(tasks.status, ["inbox", "active", "waiting_on"])).all();
    const activeWorkers = db.select().from(workerRuns).where(isNull(workerRuns.endedAt)).all();
    const activeRuns = db.select().from(workflowRuns).where(inArray(workflowRuns.status, ["pending", "running"])).all();
    const unread = db.select().from(inboxItems).where(eq(inboxItems.isRead, false)).all();
    return json(res, {
      tasks: openTasks,
      agents: [],
      active_workers: activeWorkers.length,
      worker_details: activeWorkers,
      unread_inbox: unread.length,
      active_workflow_runs: activeRuns.length,
      timestamp: new Date().toISOString(),
    });
  }

  if (sub === "activity") {
    // Return recent worker runs as activity log
    const recent = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(50).all();
    const activity = recent.map(r => ({
      id: r.id,
      type: "worker_run",
      summary: r.summary ?? `Worker run ${r.workerId}`,
      agent: r.agentType,
      task_id: r.taskId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      succeeded: r.succeeded,
    }));
    return json(res, { items: activity, timestamp: new Date().toISOString() });
  }

  if (sub === "costs") {
    const events = db.select().from(modelUsageEvents).orderBy(desc(modelUsageEvents.timestamp)).limit(500).all();
    const totalCost = events.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0);
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    for (const e of events) {
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + (e.estimatedCostUsd ?? 0);
      byModel[e.model] = (byModel[e.model] ?? 0) + (e.estimatedCostUsd ?? 0);
    }
    return json(res, {
      total_cost_usd: totalCost,
      by_provider: byProvider,
      by_model: byModel,
      event_count: events.length,
      timestamp: new Date().toISOString(),
    });
  }

  if (sub === "updates") {
    // Return stub system update info
    return json(res, {
      current_version: "0.0.1",
      update_available: false,
      last_check: new Date().toISOString(),
    });
  }

  // Default: same as overview for backward compat
  const openTasks = db.select().from(tasks).where(inArray(tasks.status, ["inbox", "active", "waiting_on"])).all();
  const activeWorkers = db.select().from(workerRuns).where(isNull(workerRuns.endedAt)).all();
  const activeRuns = db.select().from(workflowRuns).where(inArray(workflowRuns.status, ["pending", "running"])).all();
  const unread = db.select().from(inboxItems).where(eq(inboxItems.isRead, false)).all();
  return json(res, {
    tasks: openTasks,
    agents: [],
    active_workers: activeWorkers.length,
    worker_details: activeWorkers,
    unread_inbox: unread.length,
    active_workflow_runs: activeRuns.length,
    timestamp: new Date().toISOString(),
  });
}
