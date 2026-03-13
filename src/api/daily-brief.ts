import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, and, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { json, error } from "./index.js";

/**
 * Daily brief endpoint — today's task summary and highlights.
 * 
 * GET /api/daily-brief → returns today's brief
 */

interface DailyBrief {
  date: string;
  tasks: {
    active: number;
    completed_today: number;
    blocked: number;
  };
  calendar: any[]; // Future: integrate Google Calendar
  highlights: string[];
}

export async function handleDailyBriefRequest(
  req: IncomingMessage,
  res: ServerResponse,
  _sub?: string,
): Promise<void> {
  if (req.method === "GET") {
    try {
      const db = getDb();
      const today = new Date().toISOString().split("T")[0];
      
      // Calculate today's start in ISO format
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartISO = todayStart.toISOString();

      // Active tasks
      const activeTasks = db
        .select()
        .from(tasks)
        .where(eq(tasks.status, "active"))
        .all();

      // Completed today
      const completedToday = db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, "completed"),
            gte(tasks.updatedAt, todayStartISO)
          )
        )
        .all();

      // Blocked tasks
      const blockedTasks = db
        .select()
        .from(tasks)
        .where(inArray(tasks.status, ["blocked", "waiting_on"]))
        .all();

      // Generate highlights based on recent activity
      const highlights: string[] = [];
      
      if (completedToday.length > 0) {
        highlights.push(`✅ Completed ${completedToday.length} task${completedToday.length > 1 ? "s" : ""} today`);
      }
      
      if (activeTasks.length > 5) {
        highlights.push(`⚠️ ${activeTasks.length} active tasks — high workload`);
      }
      
      if (blockedTasks.length > 0) {
        highlights.push(`🚧 ${blockedTasks.length} blocked task${blockedTasks.length > 1 ? "s" : ""} need attention`);
      }

      // Check for high-priority tasks
      const urgentTasks = activeTasks.filter(t => t.priority === "high" || t.priority === "urgent");
      if (urgentTasks.length > 0) {
        highlights.push(`🔥 ${urgentTasks.length} high-priority task${urgentTasks.length > 1 ? "s" : ""} in progress`);
      }

      // If nothing notable, add a default message
      if (highlights.length === 0) {
        highlights.push("📋 No urgent items — steady state");
      }

      const brief: DailyBrief = {
        date: today,
        tasks: {
          active: activeTasks.length,
          completed_today: completedToday.length,
          blocked: blockedTasks.length,
        },
        calendar: [], // TODO: Integrate Google Calendar API if available
        highlights,
      };

      return json(res, brief);
    } catch (err) {
      return error(res, `Failed to generate daily brief: ${String(err)}`, 500);
    }
  }

  return error(res, "Invalid daily-brief endpoint", 404);
}
