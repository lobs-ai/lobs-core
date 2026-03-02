import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { workflowRuns } from "../db/schema.js";
import { json, error, parseQuery } from "./index.js";

export async function handleWorkflowRunsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runId?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2];

  if (runId && sub === "trace") {
    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
    if (!run) return error(res, "Not found", 404);
    return json(res, {
      run_id: runId,
      workflow_id: run.workflowId,
      status: run.status,
      node_states: run.nodeStates,
      context: run.context,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    });
  }

  if (runId) {
    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
    return run ? json(res, run) : error(res, "Not found", 404);
  }

  const q = parseQuery(req.url ?? "");
  const limit = parseInt(q.limit ?? "50", 10);
  const runs = db.select().from(workflowRuns).orderBy(desc(workflowRuns.createdAt)).limit(limit).all();
  return json(res, runs);
}
