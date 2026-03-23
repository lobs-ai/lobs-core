/**
 * GET /api/queue-metrics
 *
 * Exposes live task-queue metrics and agent idle/busy state in one call.
 *
 * Response shape:
 * {
 *   snapshot: {
 *     active_tasks: number,       // work_state = 'in_progress'
 *     pending_tasks: number,      // status = 'active' AND work_state = 'not_started'
 *     blocked_tasks: number,      // status = 'active' AND blocked_by is not null
 *     failed_tasks_24h: number,   // status = 'active' AND work_state = 'failed', updated in last 24h
 *     active_workers: number,     // worker_runs with no endedAt
 *     pending_spawns: number,     // in-flight spawn requests
 *   },
 *   by_project: [{ project_id, project_name, active, pending, blocked, in_flight }],
 *   by_agent: [{ agent_type, active, pending }],
 *   agents: [{ agent_type, status, current_task_id, current_project_id, last_active_at, last_completed_at, idle_seconds }],
 *   recent_events: QueueEvent[],  // last N queue log events (newest first)
 *   event_counters: Record<string, number>,
 *   generated_at: string,
 * }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import {
  tasks,
  agentStatus as agentStatusTable,
  workerRuns,
  projects,
} from "../db/schema.js";
import { json, parseQuery } from "./index.js";
import { getRecentQueueEvents, getEventCounters } from "../util/queue-logger.js";
import {
  getActiveWorkers,
  getPendingSpawnCount,
} from "../orchestrator/worker-manager.js";

// ── Helper types ──────────────────────────────────────────────────────────────

interface ProjectBucket {
  project_id: string;
  project_title: string | null;
  active: number;
  pending: number;
  blocked: number;
  in_flight: number;
}

interface AgentBucket {
  agent_type: string;
  active: number;
  pending: number;
}

interface AgentRow {
  agent_type: string;
  status: string | null;
  current_task_id: string | null;
  current_project_id: string | null;
  last_active_at: string | null;
  last_completed_at: string | null;
  idle_seconds: number | null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleQueueMetrics(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const eventLimit = Math.min(parseInt(query.events ?? "50", 10), 200);

  const db = getDb();
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  try {
    // ── 1. Task counts ────────────────────────────────────────────────────

    const allActiveTasks = db
      .select({
        id: tasks.id,
        workState: tasks.workState,
        blockedBy: tasks.blockedBy,
        projectId: tasks.projectId,
        agent: tasks.agent,
        finishedAt: tasks.finishedAt,
      })
      .from(tasks)
      .where(eq(tasks.status, "active"))
      .all();

    let activeCount = 0;
    let pendingCount = 0;
    let blockedCount = 0;
    let failed24hCount = 0;

    const projectMap = new Map<string, ProjectBucket>();
    const agentMap = new Map<string, AgentBucket>();

    // Fetch project names in bulk
    const projectRows = db.select({ id: projects.id, title: projects.title }).from(projects).all();
    const projectNameById = new Map(projectRows.map(p => [p.id, p.title]));

    for (const t of allActiveTasks) {
      const hasBlock = t.blockedBy && JSON.stringify(t.blockedBy) !== "null" && JSON.stringify(t.blockedBy) !== "[]";
      if (t.workState === "in_progress") activeCount++;
      else if (t.workState === "not_started" && !hasBlock) pendingCount++;
      if (hasBlock) blockedCount++;
      if (t.workState === "failed" && t.finishedAt && t.finishedAt >= cutoff24h) failed24hCount++;

      // Per-project bucket
      const pid = t.projectId ?? "__none__";
      if (!projectMap.has(pid)) {
        projectMap.set(pid, {
          project_id: pid,
          project_title: pid === "__none__" ? null : (projectNameById.get(pid) ?? null),
          active: 0,
          pending: 0,
          blocked: 0,
          in_flight: 0,
        });
      }
      const pb = projectMap.get(pid)!;
      if (t.workState === "in_progress") pb.active++;
      else if (t.workState === "not_started" && !hasBlock) pb.pending++;
      if (hasBlock) pb.blocked++;

      // Per-agent bucket
      const at = t.agent ?? "__none__";
      if (!agentMap.has(at)) agentMap.set(at, { agent_type: at, active: 0, pending: 0 });
      const ab = agentMap.get(at)!;
      if (t.workState === "in_progress") ab.active++;
      else if (t.workState === "not_started" && !hasBlock) ab.pending++;
    }

    // ── 2. Active workers — enrich project buckets with in_flight count ──

    const activeWorkers = getActiveWorkers();
    for (const w of activeWorkers) {
      const pid = w.projectId ?? "__none__";
      if (projectMap.has(pid)) projectMap.get(pid)!.in_flight++;
    }

    // ── 3. Agent status rows ──────────────────────────────────────────────

    const agentRows = db
      .select({
        agentType: agentStatusTable.agentType,
        status: agentStatusTable.status,
        currentTaskId: agentStatusTable.currentTaskId,
        currentProjectId: agentStatusTable.currentProjectId,
        lastActiveAt: agentStatusTable.lastActiveAt,
        lastCompletedAt: agentStatusTable.lastCompletedAt,
      })
      .from(agentStatusTable)
      .all();

    const agents: AgentRow[] = agentRows.map(r => {
      let idleSeconds: number | null = null;
      if (r.status !== "busy" && r.lastActiveAt) {
        idleSeconds = Math.round((now.getTime() - new Date(r.lastActiveAt).getTime()) / 1000);
      }
      return {
        agent_type: r.agentType,
        status: r.status,
        current_task_id: r.currentTaskId,
        current_project_id: r.currentProjectId,
        last_active_at: r.lastActiveAt,
        last_completed_at: r.lastCompletedAt,
        idle_seconds: idleSeconds,
      };
    });

    // ── 4. Assemble response ──────────────────────────────────────────────

    const response = {
      snapshot: {
        active_tasks: activeCount,
        pending_tasks: pendingCount,
        blocked_tasks: blockedCount,
        failed_tasks_24h: failed24hCount,
        active_workers: activeWorkers.length,
        pending_spawns: getPendingSpawnCount(),
        total_active_project_tasks: allActiveTasks.length,
      },
      by_project: [...projectMap.values()].sort((a, b) =>
        (b.active + b.pending) - (a.active + a.pending)
      ),
      by_agent: [...agentMap.values()]
        .filter(a => a.agent_type !== "__none__")
        .sort((a, b) => (b.active + b.pending) - (a.active + a.pending)),
      agents: agents.sort((a, b) => {
        // Busy agents first, then sort by last_active_at desc
        if (a.status === "busy" && b.status !== "busy") return -1;
        if (b.status === "busy" && a.status !== "busy") return 1;
        return (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "");
      }),
      recent_events: getRecentQueueEvents(eventLimit),
      event_counters: getEventCounters(),
      generated_at: now.toISOString(),
    };

    json(res, response);
  } catch (e) {
    json(res, { error: String(e) }, 500);
  }
}
