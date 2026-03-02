import { desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { workerRuns } from "../db/schema.js";
import { json, parseQuery } from "./index.js";

export async function handleWorkerRequest(req: IncomingMessage, res: ServerResponse, _id?: string): Promise<void> {
  const db = getDb();
  const q = parseQuery(req.url ?? "");
  const limit = parseInt(q.limit ?? "50", 10);
  const rows = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(limit).all();
  return json(res, rows);
}
