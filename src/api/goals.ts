/**
 * Goals API — GET /api/goals
 *
 * Returns active goals with open task counts, completed task counts,
 * and the 5 most recent tasks per goal (for the Nexus Goals panel).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { json, error } from "./index.js";

export async function handleGoalsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  _sub?: string,
): Promise<void> {
  if (req.method !== "GET") {
    return error(res, "Method not allowed", 405);
  }

  try {
    const db = getDb();

    // Load all active goals ordered by priority DESC (higher priority first)
    const activeGoals = db
      .select()
      .from(goals)
      .where(eq(goals.status, "active"))
      .orderBy(desc(goals.priority))
      .all();

    if (activeGoals.length === 0) {
      return json(res, { goals: [] });
    }

    const goalIds = activeGoals.map(g => g.id);

    // Count open tasks per goal
    const openTaskRows = db
      .select({
        goalId: tasks.goalId,
        openCount: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .where(
        and(
          inArray(tasks.goalId, goalIds),
          inArray(tasks.status, ["inbox", "active", "in_progress"]),
        ),
      )
      .groupBy(tasks.goalId)
      .all();

    const openCountByGoal = new Map<string, number>();
    for (const row of openTaskRows) {
      if (row.goalId) {
        openCountByGoal.set(row.goalId, Number(row.openCount));
      }
    }

    // Count completed tasks per goal
    const completedTaskRows = db
      .select({
        goalId: tasks.goalId,
        completedCount: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .where(
        and(
          inArray(tasks.goalId, goalIds),
          eq(tasks.status, "completed"),
        ),
      )
      .groupBy(tasks.goalId)
      .all();

    const completedCountByGoal = new Map<string, number>();
    for (const row of completedTaskRows) {
      if (row.goalId) {
        completedCountByGoal.set(row.goalId, Number(row.completedCount));
      }
    }

    // Fetch recent tasks per goal (all statuses, ordered by updatedAt desc)
    const recentTaskRows = db
      .select({
        id: tasks.id,
        goalId: tasks.goalId,
        title: tasks.title,
        status: tasks.status,
        notes: tasks.notes,
        updatedAt: tasks.updatedAt,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(inArray(tasks.goalId, goalIds))
      .orderBy(desc(tasks.updatedAt))
      .all();

    // Group by goalId, keep top 5 per goal
    const recentByGoal = new Map<string, typeof recentTaskRows>();
    for (const row of recentTaskRows) {
      if (!row.goalId) continue;
      const existing = recentByGoal.get(row.goalId) ?? [];
      if (existing.length < 5) {
        existing.push(row);
        recentByGoal.set(row.goalId, existing);
      }
    }

    const result = activeGoals.map(g => ({
      id: g.id,
      title: g.title,
      description: g.description,
      status: g.status,
      priority: g.priority,
      owner: g.owner,
      projectId: g.projectId,
      tags: g.tags,
      lastWorked: g.lastWorked,
      notes: g.notes,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      openTaskCount: openCountByGoal.get(g.id) ?? 0,
      completedTaskCount: completedCountByGoal.get(g.id) ?? 0,
      recentTasks: recentByGoal.get(g.id) ?? [],
    }));

    return json(res, { goals: result });
  } catch (err) {
    return error(res, `Failed to fetch goals: ${String(err)}`, 500);
  }
}
