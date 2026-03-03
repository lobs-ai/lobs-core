// New status.ts that matches MC's SystemOverview model
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, inArray, isNull, desc, gte, and } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, workerRuns, workflowRuns, inboxItems, modelUsageEvents } from "../db/schema.js";
import { json, error } from "./index.js";

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
    const completedWorkers = db.select().from(workerRuns).where(eq(workerRuns.succeeded, true)).all();
    const failedWorkers = db.select().from(workerRuns).where(eq(workerRuns.succeeded, false)).all();
    const unread = db.select().from(inboxItems).where(eq(inboxItems.isRead, false)).all();

    const activeTasks = openTasks.filter(t => t.status === "active");
    const waitingTasks = openTasks.filter(t => t.status === "waiting_on");
    const blockedTasks = openTasks.filter(t => t.status === "blocked");
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const completedToday = db.select().from(tasks)
      .where(and(eq(tasks.status, "completed"), gte(tasks.updatedAt, todayStart.toISOString())))
      .all();

    return json(res, {
      server: {
        status: "healthy",
        uptime_seconds: Math.floor(process.uptime()),
        version: "0.1.0",
      },
      orchestrator: {
        running: true,
        paused: false,
      },
      workers: {
        active: activeWorkers.length,
        total_completed: completedWorkers.length,
        total_failed: failedWorkers.length,
      },
      agents: [],
      tasks: {
        active: activeTasks.length,
        waiting: waitingTasks.length,
        blocked: blockedTasks.length,
        completed_today: completedToday.length,
      },
      memories: {
        total: 0,
        today_entries: 0,
      },
      inbox: {
        unread: unread.length,
      },
    });
  }

  if (sub === "activity") {
    const recent = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(50).all();
    const activity = recent.map(r => ({
      type: r.succeeded ? "worker_completed" : (r.endedAt ? "worker_failed" : "worker_spawned"),
      title: r.summary ?? `${r.agentType} worker run`,
      timestamp: r.endedAt ?? r.startedAt ?? new Date().toISOString(),
      details: r.model ? `Model: ${r.model}` : null,
    }));
    return json(res, activity);
  }

  if (sub === "costs") {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now - 7 * 24 * 3600_000);
    const monthStart = new Date(now - 30 * 24 * 3600_000);

    const allEvents = db.select().from(modelUsageEvents)
      .where(gte(modelUsageEvents.timestamp, monthStart.toISOString()))
      .all();

    const calcPeriod = (events: typeof allEvents) => {
      const tokensIn = events.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
      const tokensOut = events.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
      const cost = events.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
      return { tokens_in: tokensIn, tokens_out: tokensOut, estimated_cost: cost };
    };

    const todayEvents = allEvents.filter(e => e.timestamp >= todayStart.toISOString());
    const weekEvents = allEvents.filter(e => e.timestamp >= weekStart.toISOString());

    // by_agent from worker_runs
    const runs = db.select().from(workerRuns).all();
    const byAgent: Record<string, { tokens: number; runs: number }> = {};
    for (const r of runs) {
      const agentKey = r.agentType ?? "unknown"; const a = byAgent[agentKey] ?? { tokens: 0, runs: 0 };
      a.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
      a.runs += 1;
      byAgent[agentKey] = a;
    }

    return json(res, {
      today: calcPeriod(todayEvents),
      week: calcPeriod(weekEvents),
      month: calcPeriod(allEvents),
      by_agent: Object.entries(byAgent).map(([type, v]) => ({
        type,
        tokens_total: v.tokens,
        runs: v.runs,
      })),
    });
  }

  if (sub === "updates") {
    return json(res, {
      repos: [],
      has_updates: false,
      checked_at: new Date().toISOString(),
    });
  }

  // Default: same as overview
  return handleStatusRequest(_req, res, "overview", _parts);
}
