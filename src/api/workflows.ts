import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { workflowDefinitions, workflowRuns } from "../db/schema.js";
import { json, parseQuery } from "./index.js";

export async function handleWorkflowRequest(req: IncomingMessage, res: ServerResponse, id?: string): Promise<void> {
  const db = getDb();
  if (id === "runs") {
    const q = parseQuery(req.url ?? "");
    const limit = parseInt(q.limit ?? "50", 10);
    return json(res, db.select().from(workflowRuns).orderBy(desc(workflowRuns.createdAt)).limit(limit).all());
  }
  if (id) {
    const wf = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).get();
    return json(res, wf ?? { error: "not found" });
  }
  return json(res, db.select().from(workflowDefinitions).orderBy(workflowDefinitions.name).all());
}
