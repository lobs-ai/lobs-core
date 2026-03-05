/**
 * Generates a context block of active/recent tasks for agent prompts.
 * Prevents agents from duplicating existing or recently completed work.
 */

import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { eq, and, inArray, desc } from "drizzle-orm";

export interface TaskContextOpts {
  projectId?: string | null;
  agentType?: string | null;
  limit?: number;
}

/**
 * Build a context string showing what's currently happening and recently done.
 */
export function buildTaskContext(opts: TaskContextOpts = {}): string {
  const db = getDb();
  const lines: string[] = [];

  // Active tasks (in-progress or queued)
  const activeTasks = db.select({
    title: tasks.title,
    agent: tasks.agent,
    workState: tasks.workState,
    projectId: tasks.projectId,
  })
    .from(tasks)
    .where(eq(tasks.status, "active"))
    .all();

  if (activeTasks.length > 0) {
    lines.push("## Currently Active Tasks");
    for (const t of activeTasks) {
      const state = t.workState === "in_progress" ? "🔄 in progress" : t.workState === "not_started" ? "⏳ queued" : `📋 ${t.workState}`;
      lines.push(`- [${state}] (${t.agent}) ${t.title}`);
    }
  }

  // Recently completed tasks (last 24h)
  const recentCompleted = db.select({
    title: tasks.title,
    agent: tasks.agent,
    updatedAt: tasks.updatedAt,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, "completed"),
    ))
    .orderBy(desc(tasks.updatedAt))
    .limit(opts.limit ?? 20)
    .all();

  if (recentCompleted.length > 0) {
    lines.push("\n## Recently Completed Tasks");
    for (const t of recentCompleted) {
      lines.push(`- ✅ (${t.agent}) ${t.title}`);
    }
  }

  if (lines.length === 0) return "";

  return `\n\n---\n### Context: Current & Recent Work\nDo NOT duplicate any of this work. If your task overlaps with something already done or in progress, focus only on what's new/different.\n\n${lines.join("\n")}\n---\n`;
}
