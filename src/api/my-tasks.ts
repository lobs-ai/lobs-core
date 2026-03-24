/**
 * Personal Tasks API — handles /api/my-tasks and sub-routes
 * These are human tasks (owner='rafe', no agent) for the nightly planner.
 */

import { randomUUID } from "node:crypto";
import { eq, and, isNull, inArray } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

const OWNER = "rafe";

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function enrichTask(row: Record<string, unknown>): Record<string, unknown> {
  const dueDate = row.dueDate as string | null;
  const today = todayISO();
  return {
    ...row,
    overdue: dueDate ? dueDate < today : false,
    dueToday: dueDate ? dueDate === today : false,
  };
}

export async function handleMyTasksRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const sub = parts[2];

  // ── GET /api/my-tasks/stats ─────────────────────────────────────────────
  if (id === "stats" && req.method === "GET") {
    const today = todayISO();
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndISO = weekEnd.toISOString().slice(0, 10);

    const active = db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.owner, OWNER),
          isNull(tasks.agent),
          inArray(tasks.status, ["inbox", "active"]),
        ),
      )
      .all();

    const completed = db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.owner, OWNER), isNull(tasks.agent), eq(tasks.status, "completed")),
      )
      .all();

    const activeCount = active.length;
    const completedCount = completed.length;
    const dueToday = active.filter((t) => t.dueDate === today).length;
    const dueSoon = active.filter(
      (t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEndISO,
    ).length;
    const overdue = active.filter((t) => t.dueDate && t.dueDate < today).length;

    return json(res, { active: activeCount, completed: completedCount, dueToday, dueSoon, overdue });
  }

  // ── POST /api/my-tasks/from-agent ───────────────────────────────────────
  if (id === "from-agent" && req.method === "POST") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const title = body.title as string;
    if (!title?.trim()) return error(res, "title is required");

    const taskId = randomUUID();
    db.insert(tasks)
      .values({
        id: taskId,
        title: title.trim(),
        status: "active",
        owner: OWNER,
        priority: (body.priority as string) || "medium",
        dueDate: (body.dueDate as string) || null,
        notes: (body.notes as string) || null,
        shape: (body.category as string) || null,
        externalSource: "agent",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const created = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return json(res, enrichTask(created as Record<string, unknown>), 201);
  }

  // ── GET /api/my-tasks ──────────────────────────────────────────────────
  if (!id && req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const status = query.status || "active";
    const sort = query.sort || "priority";

    const statusValues = status === "completed" ? ["completed"] : ["inbox", "active"];

    const rows = db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.owner, OWNER),
          isNull(tasks.agent),
          inArray(tasks.status, statusValues),
        ),
      )
      .all();

    // Sort in JS since priority is semantic
    const enriched = rows.map((r) => enrichTask(r as Record<string, unknown>));

    if (sort === "priority") {
      enriched.sort((a, b) => {
        const pa = PRIORITY_ORDER[(a.priority as string) ?? "medium"] ?? 2;
        const pb = PRIORITY_ORDER[(b.priority as string) ?? "medium"] ?? 2;
        if (pa !== pb) return pa - pb;
        // Secondary sort: due date (nulls last)
        const da = (a.dueDate as string) || "9999";
        const db2 = (b.dueDate as string) || "9999";
        return da.localeCompare(db2);
      });
    } else if (sort === "due_date") {
      enriched.sort((a, b) => {
        const da = (a.dueDate as string) || "9999";
        const db2 = (b.dueDate as string) || "9999";
        return da.localeCompare(db2);
      });
    } else {
      enriched.sort((a, b) => {
        const ca = (a.createdAt as string) || "";
        const cb = (b.createdAt as string) || "";
        return cb.localeCompare(ca); // newest first
      });
    }

    return json(res, { tasks: enriched });
  }

  // ── POST /api/my-tasks ─────────────────────────────────────────────────
  if (!id && req.method === "POST") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const title = body.title as string;
    if (!title?.trim()) return error(res, "title is required");

    const taskId = randomUUID();
    db.insert(tasks)
      .values({
        id: taskId,
        title: title.trim(),
        status: "active",
        owner: OWNER,
        priority: (body.priority as string) || "medium",
        dueDate: (body.dueDate as string) || null,
        notes: (body.notes as string) || null,
        shape: (body.category as string) || null,
        estimatedMinutes: body.estimatedMinutes ? Number(body.estimatedMinutes) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const created = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return json(res, enrichTask(created as Record<string, unknown>), 201);
  }

  // ── Single task routes: /api/my-tasks/:id/... ──────────────────────────
  if (!id) return error(res, "Not found", 404);

  // Verify ownership
  const existing = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.owner, OWNER)))
    .get();
  if (!existing) return error(res, "Task not found", 404);

  // POST /api/my-tasks/:id/complete
  if (sub === "complete" && req.method === "POST") {
    db.update(tasks)
      .set({ status: "completed", finishedAt: now, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return json(res, enrichTask(updated as Record<string, unknown>));
  }

  // POST /api/my-tasks/:id/snooze
  if (sub === "snooze" && req.method === "POST") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const until = body.until as string;
    let scheduledStart: string;

    if (until === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      scheduledStart = d.toISOString().slice(0, 10);
    } else if (until === "next_week") {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      scheduledStart = d.toISOString().slice(0, 10);
    } else {
      scheduledStart = until;
    }

    db.update(tasks)
      .set({ status: "snoozed", scheduledStart, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return json(res, enrichTask(updated as Record<string, unknown>));
  }

  // PATCH /api/my-tasks/:id
  if (!sub && req.method === "PATCH") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.dueDate !== undefined) updates.dueDate = body.dueDate || null;
    if (body.category !== undefined) updates.shape = body.category;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.estimatedMinutes !== undefined)
      updates.estimatedMinutes = body.estimatedMinutes ? Number(body.estimatedMinutes) : null;

    db.update(tasks).set(updates).where(eq(tasks.id, id)).run();
    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return json(res, enrichTask(updated as Record<string, unknown>));
  }

  // DELETE /api/my-tasks/:id
  if (!sub && req.method === "DELETE") {
    db.delete(tasks).where(eq(tasks.id, id)).run();
    return json(res, { deleted: true });
  }

  return error(res, "Method not allowed", 405);
}
