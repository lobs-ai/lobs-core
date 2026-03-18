import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, and, gte, inArray, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { json, error } from "./index.js";
import { getCachedBrief, getCachedHealth, generateDailyBriefSummary } from "../services/system-sentinel.js";
import { getSchedulerIntelligenceSnapshot } from "../services/scheduler-intelligence.js";

/**
 * Daily brief endpoint — AI-enhanced daily summary.
 * 
 * GET /api/daily-brief → returns today's brief with AI narrative
 * POST /api/daily-brief/refresh → force regenerate the AI summary
 */

interface DailyBriefResponse {
  date: string;
  tasks: {
    active: number;
    completed_today: number;
    blocked: number;
    overdue: number;
  };
  activeTasks: Array<{ id: string; title: string; status: string; priority: string | null; project: string | null }>;
  completedToday: Array<{ id: string; title: string; completedAt: string }>;
  blockedTasks: Array<{ id: string; title: string; blockedBy: string | null }>;
  calendar: any[]; // Populated by calendar sentinel when available
  highlights: string[];
  aiSummary: {
    narrative: string;
    topPriorities: string[];
    concerns: string[];
    suggestedActions: string[];
  } | null;
  sentinel: {
    alerts: Array<{ type: string; severity: string; message: string }>;
    summary: string;
  } | null;
  scheduler: Awaited<ReturnType<typeof getSchedulerIntelligenceSnapshot>> | null;
}

export async function handleDailyBriefRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  // POST /api/daily-brief/refresh — force refresh AI summary
  if (sub === "refresh" && req.method === "POST") {
    try {
      const brief = await generateDailyBriefSummary();
      return json(res, { success: true, aiSummary: brief });
    } catch (err) {
      return error(res, `Failed to refresh brief: ${String(err)}`, 500);
    }
  }

  if (req.method === "GET") {
    try {
      const db = getDb();
      const today = new Date().toISOString().split("T")[0];
      
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartISO = todayStart.toISOString();

      // Active tasks with project info
      const activeRows = db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          projectId: tasks.projectId,
        })
        .from(tasks)
        .where(inArray(tasks.status, ["active", "in_progress"]))
        .orderBy(desc(tasks.updatedAt))
        .all();

      // Build project map
      const projectMap = new Map<string, string>();
      const projectIds = [...new Set(activeRows.map(t => t.projectId).filter(Boolean))];
      for (const pid of projectIds) {
        const p = db.select({ title: projects.title }).from(projects).where(eq(projects.id, pid as string)).get();
        if (p) projectMap.set(pid as string, p.title);
      }

      const activeTasks = activeRows.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.projectId ? projectMap.get(t.projectId) ?? null : null,
      }));

      // Completed today
      const completedRows = db
        .select({ id: tasks.id, title: tasks.title, updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(and(
          eq(tasks.status, "completed"),
          gte(tasks.updatedAt, todayStartISO),
        ))
        .all();

      const completedToday = completedRows.map(t => ({
        id: t.id,
        title: t.title,
        completedAt: t.updatedAt,
      }));

      // Blocked tasks
      const blockedRows = db
        .select({ id: tasks.id, title: tasks.title, blockedBy: tasks.blockedBy })
        .from(tasks)
        .where(inArray(tasks.status, ["blocked", "waiting_on"]))
        .all();

      const blockedTasks = blockedRows.map(t => ({
        id: t.id,
        title: t.title,
        blockedBy: typeof t.blockedBy === "string" ? t.blockedBy : null,
      }));

      // Overdue tasks
      const now = new Date().toISOString();
      const overdueRows = db
        .select()
        .from(tasks)
        .where(and(
          inArray(tasks.status, ["active", "in_progress"]),
        ))
        .all()
        .filter(t => t.dueDate && t.dueDate < now);

      // Generate highlights
      const highlights: string[] = [];
      
      if (completedToday.length > 0) {
        highlights.push(`✅ Completed ${completedToday.length} task${completedToday.length > 1 ? "s" : ""} today`);
      }
      if (activeRows.length > 5) {
        highlights.push(`⚠️ ${activeRows.length} active tasks — high workload`);
      }
      if (blockedRows.length > 0) {
        highlights.push(`🚧 ${blockedRows.length} blocked task${blockedRows.length > 1 ? "s" : ""} need attention`);
      }
      if (overdueRows.length > 0) {
        highlights.push(`🔥 ${overdueRows.length} overdue task${overdueRows.length > 1 ? "s" : ""}`);
      }
      const urgentTasks = activeRows.filter(t => t.priority === "high" || t.priority === "urgent");
      if (urgentTasks.length > 0) {
        highlights.push(`🔴 ${urgentTasks.length} high-priority task${urgentTasks.length > 1 ? "s" : ""}`);
      }
      if (highlights.length === 0) {
        highlights.push("📋 No urgent items — steady state");
      }

      // Get AI-generated content from sentinel cache
      const aiSummary = getCachedBrief();
      const health = getCachedHealth();

      const scheduler = await getSchedulerIntelligenceSnapshot().catch(() => null);

      const brief: DailyBriefResponse = {
        date: today,
        tasks: {
          active: activeRows.length,
          completed_today: completedToday.length,
          blocked: blockedRows.length,
          overdue: overdueRows.length,
        },
        activeTasks,
        completedToday,
        blockedTasks,
        calendar: [], // Populated when Google Calendar sentinel is running
        highlights,
        aiSummary: aiSummary ? {
          narrative: aiSummary.narrative,
          topPriorities: aiSummary.topPriorities,
          concerns: aiSummary.concerns,
          suggestedActions: aiSummary.suggestedActions,
        } : null,
        sentinel: health ? {
          alerts: health.alerts,
          summary: health.summary,
        } : null,
        scheduler,
      };

      return json(res, brief);
    } catch (err) {
      return error(res, `Failed to generate daily brief: ${String(err)}`, 500);
    }
  }

  return error(res, "Invalid daily-brief endpoint", 404);
}
