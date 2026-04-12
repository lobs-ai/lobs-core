/**
 * Goals API — GET /api/goals
 *
 * Returns active goals with open task counts, completed task counts,
 * and the 5 most recent tasks per goal (for the Nexus Goals panel).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export async function handleGoalsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  // POST /api/goals — create a new goal
  if (req.method === "POST" && !sub) {
    return handleCreateGoal(req, res);
  }

  // PATCH /api/goals/:id — update a goal (status, priority, title, description)
  if (req.method === "PATCH" && sub) {
    return handleUpdateGoal(req, res, sub);
  }

  // DELETE /api/goals/:id — archive a goal
  if (req.method === "DELETE" && sub) {
    return handleDeleteGoal(req, res, sub);
  }

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
        agent: tasks.agent,
        updatedAt: tasks.updatedAt,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(inArray(tasks.goalId, goalIds))
      .orderBy(desc(tasks.updatedAt))
      .all();

    // Separate agent sessions from manual tasks, group by goalId
    const recentSessionsByGoal = new Map<string, Array<{
      id: string;
      status: string;
      notes: string | null;
      updatedAt: string | null;
      isActive: boolean;
    }>>();
    const recentManualByGoal = new Map<string, Array<{
      id: string;
      title: string;
      status: string;
      updatedAt: string | null;
    }>>();

    for (const row of recentTaskRows) {
      if (!row.goalId) continue;

      // Agent session tracking tasks: agent='programmer' + notes starts with "Agent session"
      // or legacy format "[goals-worker]" title
      const isAgentSession =
        row.agent === "programmer" &&
        (row.notes?.startsWith("Agent session") || row.title === row.title); // all programmer tasks

      if (isAgentSession && row.agent === "programmer") {
        const existing = recentSessionsByGoal.get(row.goalId) ?? [];
        if (existing.length < 5) {
          // Extract a clean summary from notes
          const rawNotes = row.notes ?? "";
          const isActive = row.status === "active";
          existing.push({
            id: row.id,
            status: row.status,
            notes: rawNotes.startsWith("Agent session in progress") ? null : rawNotes.slice(0, 400),
            updatedAt: row.updatedAt,
            isActive,
          });
          recentSessionsByGoal.set(row.goalId, existing);
        }
      } else {
        // Manual tasks (inbox, active, completed — not agent-generated)
        const existing = recentManualByGoal.get(row.goalId) ?? [];
        if (existing.length < 5) {
          existing.push({
            id: row.id,
            title: row.title,
            status: row.status,
            updatedAt: row.updatedAt,
          });
          recentManualByGoal.set(row.goalId, existing);
        }
      }
    }

    // Count active sessions per goal (for the "in flight" indicator)
    const activeSessionByGoal = new Map<string, boolean>();
    for (const [goalId, sessions] of recentSessionsByGoal) {
      activeSessionByGoal.set(goalId, sessions.some(s => s.isActive));
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
      // Agent sessions — what the system has done autonomously
      recentSessions: recentSessionsByGoal.get(g.id) ?? [],
      // Manual tasks — created by agents or Rafe (non-programmer-agent tracking tasks)
      recentTasks: recentManualByGoal.get(g.id) ?? [],
      // Whether an agent session is currently running for this goal
      sessionActive: activeSessionByGoal.get(g.id) ?? false,
    }));

    return json(res, { goals: result });
  } catch (err) {
    return error(res, `Failed to fetch goals: ${String(err)}`, 500);
  }
}

// ── Create Goal ────────────────────────────────────────────────────────────

async function handleCreateGoal(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return error(res, "title is required", 400);

    const db = getDb();
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    await db.insert(goals).values({
      id,
      title,
      description: typeof body.description === "string" ? body.description : null,
      status: "active",
      priority: typeof body.priority === "number" ? body.priority : 50,
      owner: "lobs",
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      notes: typeof body.notes === "string" ? body.notes : null,
      createdAt: now,
      updatedAt: now,
    });

    return json(res, { id, title, status: "active" }, 201);
  } catch (err) {
    return error(res, `Failed to create goal: ${String(err)}`, 500);
  }
}

// ── Update Goal ────────────────────────────────────────────────────────────

async function handleUpdateGoal(
  req: IncomingMessage,
  res: ServerResponse,
  goalId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!existing) return error(res, "Goal not found", 404);

    const body = (await parseBody(req)) as Record<string, unknown>;
    const updates: Partial<typeof goals.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };

    if (typeof body.title === "string") updates.title = body.title.trim();
    if (typeof body.description === "string") updates.description = body.description;
    if (typeof body.status === "string") updates.status = body.status;
    if (typeof body.priority === "number") updates.priority = body.priority;
    if (typeof body.notes === "string") updates.notes = body.notes;
    if (Array.isArray(body.tags)) updates.tags = body.tags as string[];

    await db.update(goals).set(updates).where(eq(goals.id, goalId));
    return json(res, { id: goalId, ...updates });
  } catch (err) {
    return error(res, `Failed to update goal: ${String(err)}`, 500);
  }
}

// ── Delete (Archive) Goal ──────────────────────────────────────────────────

async function handleDeleteGoal(
  _req: IncomingMessage,
  res: ServerResponse,
  goalId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!existing) return error(res, "Goal not found", 404);

    await db.update(goals).set({
      status: "archived",
      updatedAt: new Date().toISOString(),
    }).where(eq(goals.id, goalId));

    return json(res, { id: goalId, status: "archived" });
  } catch (err) {
    return error(res, `Failed to archive goal: ${String(err)}`, 500);
  }
}
