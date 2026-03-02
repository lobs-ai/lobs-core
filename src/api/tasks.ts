/**
 * Task CRUD API — /paw/api/tasks
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

export function registerTaskRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/tasks
  api.registerHttpRoute({
    path: "/paw/api/tasks",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const db = getDb();
        const query = parseQuery(req.url ?? "");
        const status = query.status;
        const projectId = query.project_id;

        let conditions = [];
        if (status) conditions.push(eq(tasks.status, status));
        if (projectId) conditions.push(eq(tasks.projectId, projectId));

        const rows = conditions.length > 0
          ? db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.updatedAt)).all()
          : db.select().from(tasks).orderBy(desc(tasks.updatedAt)).all();

        json(res, rows);
      } else if (req.method === "POST") {
        const db = getDb();
        const body = await parseBody(req) as Record<string, unknown>;

        if (!body.title) return error(res, "title is required");

        const id = (body.id as string) ?? randomUUID();
        const now = new Date().toISOString();

        db.insert(tasks).values({
          id,
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

        const created = db.select().from(tasks).where(eq(tasks.id, id)).get();
        json(res, created, 201);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET/PATCH/DELETE /paw/api/tasks/:id
  api.registerHttpRoute({
    path: "/paw/api/tasks/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/tasks\/([^/?]+)/);
      if (!match) return error(res, "Task ID required", 400);
      const taskId = match[1];

      const db = getDb();

      if (req.method === "GET") {
        const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
        if (!row) return error(res, "Not found", 404);
        json(res, row);
      } else if (req.method === "PATCH") {
        const body = await parseBody(req) as Record<string, unknown>;
        const now = new Date().toISOString();

        // Build update object from provided fields
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

        db.update(tasks).set(update).where(eq(tasks.id, taskId)).run();
        const updated = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
        json(res, updated);
      } else if (req.method === "DELETE") {
        db.delete(tasks).where(eq(tasks.id, taskId)).run();
        json(res, { deleted: true });
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET /paw/api/tasks/open — convenience for active/inbox tasks
  api.registerHttpRoute({
    path: "/paw/api/tasks/open",
    handler: async (_req, res) => {
      const db = getDb();
      const rows = db.select().from(tasks)
        .where(inArray(tasks.status, ["inbox", "active", "waiting_on"]))
        .orderBy(desc(tasks.updatedAt))
        .all();
      json(res, rows);
    },
  });
}
