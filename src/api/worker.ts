import { isNull, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { workerRuns } from "../db/schema.js";
import { json, parseQuery } from "./index.js";

export async function handleWorkerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  _parts: string[] = [],
): Promise<void> {
  const db = getDb();

  if (id === "status") {
    const activeWorkers = db.select().from(workerRuns).where(isNull(workerRuns.endedAt)).all();
    return json(res, {
      active: activeWorkers.length > 0,
      workers: activeWorkers,
      timestamp: new Date().toISOString(),
    });
  }

  if (id === "history") {
    const q = parseQuery(req.url ?? "");
    const limit = parseInt(q.limit ?? "50", 10);
    const rows = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(limit).all();
    return json(res, rows);
  }

  // Default: list all (backward compat)
  const q = parseQuery(req.url ?? "");
  const limit = parseInt(q.limit ?? "50", 10);
  const rows = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(limit).all();
  return json(res, rows);
}
