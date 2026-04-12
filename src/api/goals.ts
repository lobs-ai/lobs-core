/**
 * Goals API — GET /api/goals
 *
 * Returns active goals with their open task counts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, and, inArray, sql } from "drizzle-orm";
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

    // Load all active goals
    const activeGoals = db
      .select()
      .from(goals)
      .where(eq(goals.status, "active"))
      .orderBy(goals.priority)
      .all();

    if (activeGoals.length === 0) {
      return json(res, { goals: [] });
    }

    const goalIds = activeGoals.map(g => g.id);

    // Count open tasks per goal in one query
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
    }));

    return json(res, { goals: result });
  } catch (err) {
    return error(res, `Failed to fetch goals: ${String(err)}`, 500);
  }
}
