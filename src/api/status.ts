import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, inArray, isNull, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, workerRuns, workflowRuns, inboxItems } from "../db/schema.js";
import { json } from "./index.js";

export async function handleStatusRequest(_req: IncomingMessage, res: ServerResponse, sub?: string): Promise<void> {
  const db = getDb();
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
