/**
 * Worker runs API — /paw/api/worker
 */

import { eq, desc, isNull, sql, count } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns } from "../db/schema.js";
import { json, error, parseQuery } from "./index.js";

export function registerWorkerRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/worker — active workers
  api.registerHttpRoute({
    path: "/paw/api/worker",
    handler: async (_req, res) => {
      const db = getDb();
      const rows = db.select().from(workerRuns)
        .where(sql`${workerRuns.endedAt} IS NULL AND ${workerRuns.startedAt} IS NOT NULL`)
        .orderBy(desc(workerRuns.startedAt))
        .all();
      json(res, rows);
    },
  });

  // GET /paw/api/worker/history — recent completed runs
  api.registerHttpRoute({
    path: "/paw/api/worker/history",
    handler: async (req, res) => {
      const db = getDb();
      const q = parseQuery(req.url ?? "");
      const limit = Math.min(parseInt(q.limit ?? "20", 10), 100);

      const rows = db.select().from(workerRuns)
        .where(sql`${workerRuns.endedAt} IS NOT NULL`)
        .orderBy(desc(workerRuns.endedAt))
        .limit(limit)
        .all();
      json(res, rows);
    },
  });

  // GET /paw/api/worker/:id — specific run
  api.registerHttpRoute({
    path: "/paw/api/worker/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/worker\/(\d+)/);
      if (!match) return error(res, "Worker run ID required", 400);
      const runId = parseInt(match[1], 10);

      const db = getDb();
      const row = db.select().from(workerRuns).where(eq(workerRuns.id, runId)).get();
      if (!row) return error(res, "Not found", 404);
      json(res, row);
    },
  });
}
