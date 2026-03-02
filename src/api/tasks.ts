/**
 * Task CRUD — handles /api/tasks and /api/tasks/:id and sub-routes
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, desc, lte } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

export async function handleTaskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {
  const db = getDb();
  const sub = parts[2]; // sub-route after /:id

  // /api/tasks/open — convenience endpoint
  if (id === "open") {
    const rows = db.select().from(tasks)
      .where(inArray(tasks.status, ["inbox", "active", "waiting_on"]))
      .orderBy(desc(tasks.updatedAt))
      .all();
    return json(res, rows);
  }

  // /api/tasks/auto-archive — POST
  if (id === "auto-archive" && req.method === "POST") {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.select().from(tasks)
      .where(and(
        inArray(tasks.status, ["completed", "rejected"]),
        lte(tasks.updatedAt, cutoff),
      ))
      .all();
    for (const t of rows) {
      db.update(tasks).set({ status: "archived", updatedAt: now }).where(eq(tasks.id, t.id)).run();
    }
    return json(res, { archived: rows.length });
  }

  // /api/tasks/:id — single task + sub-routes
  if (id) {
    // Sub-routes
    if (sub === "status" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.status) return error(res, "status required");
      db.update(tasks).set({ status: body.status as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "work-state" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.work_state) return error(res, "work_state required");
      db.update(tasks).set({ workState: body.work_state as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "review-state" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.review_state) return error(res, "review_state required");
      db.update(tasks).set({ reviewState: body.review_state as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "archive" && req.method === "POST") {
      db.update(tasks).set({ status: "archived", updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "artifact" && req.method === "GET") {
      const row = db.select({ artifactPath: tasks.artifactPath }).from(tasks).where(eq(tasks.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, { artifact_path: row.artifactPath ?? null });
    }

    if (req.method === "GET") {
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, row);
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const now = new Date().toISOString();
      const update: Record<string, unknown> = { updatedAt: now };
      const fieldMap: Record<string, string> = {
        title: "title", status: "status", owner: "owner",
        work_state: "workState", review_state: "reviewState",
        project_id: "projectId", notes: "notes", agent: "agent",
        model_tier: "modelTier", failure_reason: "failureReason",
        escalation_tier: "escalationTier", retry_count: "retryCount",
      };
      for (const [apiKey, schemaKey] of Object.entries(fieldMap)) {
        if (apiKey in body) update[schemaKey] = body[apiKey];
      }
      db.update(tasks).set(update).where(eq(tasks.id, id)).run();
      const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
      return json(res, updated);
    }
    if (req.method === "DELETE") {
      db.delete(tasks).where(eq(tasks.id, id)).run();
      return json(res, { deleted: true });
    }
    return error(res, "Method not allowed", 405);
  }

  // /api/tasks — list or create
  if (req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const conditions = [];
    if (query.status) conditions.push(eq(tasks.status, query.status));
    if (query.project_id) conditions.push(eq(tasks.projectId, query.project_id));

    const rows = conditions.length > 0
      ? db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.updatedAt)).all()
      : db.select().from(tasks).orderBy(desc(tasks.updatedAt)).all();
    return json(res, rows);
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title) return error(res, "title is required");
    const taskId = (body.id as string) ?? randomUUID();
    const now = new Date().toISOString();
    db.insert(tasks).values({
      id: taskId,
      title: body.title as string,
      status: (body.status as string) ?? "inbox",
      owner: body.owner as string,
      projectId: body.project_id as string,
      notes: body.notes as string,
      agent: body.agent as string,
      modelTier: body.model_tier as string,
      createdAt: now,
      updatedAt: now,
    }).run();
    const created = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return json(res, created, 201);
  }
  return error(res, "Method not allowed", 405);
}
