import type { IncomingMessage, ServerResponse } from "node:http";
import { desc, gte, isNull } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, workerRuns } from "../db/schema.js";
import { json } from "./index.js";

/**
 * Public Pulse API — sanitized, aggregate-only data for the public website.
 *
 * PRIVACY RULES:
 * - NO task titles, notes, descriptions, or content
 * - NO file paths or repo names
 * - NO chat messages or memory content
 * - NO user profile information
 * - NO calendar or inbox data
 * - ONLY aggregate counts, types, timestamps, and status
 */
export async function handlePublicPulseRequest(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const db = getDb();

  // --- System Status ---
  const uptimeSeconds = Math.floor(process.uptime());

  // --- Task Aggregates (counts only, no content) ---
  const allTasks = db
    .select({
      status: tasks.status,
      agent: tasks.agent,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .all();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const taskStats = {
    active: allTasks.filter((t) => t.status === "active").length,
    completed_today: allTasks.filter(
      (t) => t.status === "completed" && t.updatedAt >= todayISO,
    ).length,
    total_completed: allTasks.filter((t) => t.status === "completed").length,
    total: allTasks.length,
  };

  // --- Worker Run Aggregates (last 30 days) ---
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

  const recentRuns = db
    .select({
      agentType: workerRuns.agentType,
      succeeded: workerRuns.succeeded,
      startedAt: workerRuns.startedAt,
      endedAt: workerRuns.endedAt,
      model: workerRuns.model,
      inputTokens: workerRuns.inputTokens,
      outputTokens: workerRuns.outputTokens,
    })
    .from(workerRuns)
    .where(gte(workerRuns.startedAt, thirtyDaysAgo))
    .orderBy(desc(workerRuns.startedAt))
    .all();

  const activeWorkers = db
    .select({
      agentType: workerRuns.agentType,
      startedAt: workerRuns.startedAt,
      model: workerRuns.model,
    })
    .from(workerRuns)
    .where(isNull(workerRuns.endedAt))
    .all();

  const totalSucceeded = recentRuns.filter((r) => r.succeeded === true).length;
  const totalFailed = recentRuns.filter((r) => r.succeeded === false).length;

  // Per-agent breakdown (type + count only, no task content)
  const agentBreakdown: Record<string, { runs: number; succeeded: number }> = {};
  for (const run of recentRuns) {
    const type = run.agentType ?? "unknown";
    const entry = agentBreakdown[type] ?? { runs: 0, succeeded: 0 };
    entry.runs++;
    if (run.succeeded === true) entry.succeeded++;
    agentBreakdown[type] = entry;
  }

  // --- Recent Activity Feed (sanitized — type + timestamp only, no content) ---
  const recentActivity = recentRuns.slice(0, 20).map((r) => ({
    type:
      r.succeeded === true
        ? "completed"
        : r.succeeded === false
          ? "failed"
          : "running",
    agent: r.agentType ?? "unknown",
    // Sanitize model to just provider prefix (no full model path or version)
    provider: r.model?.split("/")[0] ?? "unknown",
    timestamp: r.endedAt ?? r.startedAt ?? new Date().toISOString(),
  }));

  // --- Token Usage (30-day aggregate) ---
  const totalTokensIn = recentRuns.reduce(
    (s, r) => s + (r.inputTokens ?? 0),
    0,
  );
  const totalTokensOut = recentRuns.reduce(
    (s, r) => s + (r.outputTokens ?? 0),
    0,
  );

  // --- Active workers (agent type + duration only, no task details) ---
  const liveWorkers = activeWorkers.map((w) => ({
    agent: w.agentType ?? "unknown",
    running_for_seconds: w.startedAt
      ? Math.floor((Date.now() - new Date(w.startedAt).getTime()) / 1000)
      : 0,
    provider: w.model?.split("/")[0] ?? "unknown",
  }));

  // Set CORS headers for public access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=30");

  return json(res, {
    system: {
      status: "online",
      uptime_seconds: uptimeSeconds,
      uptime_human: formatUptime(uptimeSeconds),
      version: "8.0",
    },
    tasks: taskStats,
    workers: {
      active: activeWorkers.length,
      runs_30d: recentRuns.length,
      succeeded_30d: totalSucceeded,
      failed_30d: totalFailed,
      success_rate_30d:
        recentRuns.length > 0
          ? Math.round((totalSucceeded / recentRuns.length) * 100)
          : 0,
      by_agent: Object.entries(agentBreakdown).map(([type, stats]) => ({
        agent: type,
        runs: stats.runs,
        success_rate:
          stats.runs > 0
            ? Math.round((stats.succeeded / stats.runs) * 100)
            : 0,
      })),
    },
    tokens_30d: {
      input: totalTokensIn,
      output: totalTokensOut,
      total: totalTokensIn + totalTokensOut,
    },
    live_workers: liveWorkers,
    recent_activity: recentActivity,
    generated_at: new Date().toISOString(),
  });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
