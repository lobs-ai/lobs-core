/**
 * Status & overview API — /paw/api/status
 */

import { eq, and, inArray, count, desc, sql } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import {
  tasks, agentStatus, workerRuns, inboxItems, workflowRuns,
} from "../db/schema.js";
import { json, error } from "./index.js";

export function registerStatusRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/status/overview
  api.registerHttpRoute({
    path: "/paw/api/status/overview",
    handler: async (_req, res) => {
      const db = getDb();

      const taskCounts = db.select({
        status: tasks.status,
        workState: tasks.workState,
        ct: count(),
      }).from(tasks)
        .groupBy(tasks.status, tasks.workState)
        .all();

      const agentStatuses = db.select().from(agentStatus).all();

      const activeWorkers = db.select().from(workerRuns)
        .where(sql`${workerRuns.endedAt} IS NULL AND ${workerRuns.startedAt} IS NOT NULL`)
        .all();

      const unreadInbox = db.select({ ct: count() })
        .from(inboxItems)
        .where(eq(inboxItems.isRead, false))
        .get();

      const activeRuns = db.select({ ct: count() })
        .from(workflowRuns)
        .where(inArray(workflowRuns.status, ["pending", "running"]))
        .get();

      json(res, {
        tasks: taskCounts,
        agents: agentStatuses,
        active_workers: activeWorkers.length,
        worker_details: activeWorkers,
        unread_inbox: unreadInbox?.ct ?? 0,
        active_workflow_runs: activeRuns?.ct ?? 0,
        timestamp: new Date().toISOString(),
      });
    },
  });

  // GET /paw/api/status/activity
  api.registerHttpRoute({
    path: "/paw/api/status/activity",
    handler: async (_req, res) => {
      const db = getDb();
      const recent = db.select().from(workerRuns)
        .orderBy(desc(workerRuns.startedAt))
        .limit(20)
        .all();
      json(res, recent);
    },
  });

  // GET /paw/api/status/costs
  api.registerHttpRoute({
    path: "/paw/api/status/costs",
    handler: async (_req, res) => {
      const db = getDb();
      const today = new Date().toISOString().slice(0, 10);

      const todayCosts = db.select({
        totalCost: sql<number>`SUM(${workerRuns.totalCostUsd})`,
        totalTokens: sql<number>`SUM(${workerRuns.totalTokens})`,
        runs: count(),
      }).from(workerRuns)
        .where(sql`${workerRuns.startedAt} >= ${today}`)
        .get();

      const allTimeCosts = db.select({
        totalCost: sql<number>`SUM(${workerRuns.totalCostUsd})`,
        totalTokens: sql<number>`SUM(${workerRuns.totalTokens})`,
        runs: count(),
      }).from(workerRuns).get();

      json(res, {
        today: {
          cost_usd: todayCosts?.totalCost ?? 0,
          tokens: todayCosts?.totalTokens ?? 0,
          runs: todayCosts?.runs ?? 0,
        },
        all_time: {
          cost_usd: allTimeCosts?.totalCost ?? 0,
          tokens: allTimeCosts?.totalTokens ?? 0,
          runs: allTimeCosts?.runs ?? 0,
        },
      });
    },
  });
}
