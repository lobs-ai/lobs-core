/**
 * Projects CRUD API — /paw/api/projects
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { projects } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

export function registerProjectRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/projects
  api.registerHttpRoute({
    path: "/paw/api/projects",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const db = getDb();
        const q = parseQuery(req.url ?? "");
        const showArchived = q.archived === "true";

        const rows = showArchived
          ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
          : db.select().from(projects)
              .where(eq(projects.archived, false))
              .orderBy(projects.sortOrder, desc(projects.updatedAt))
              .all();

        json(res, rows);
      } else if (req.method === "POST") {
        const db = getDb();
        const body = await parseBody(req) as Record<string, unknown>;
        if (!body.title) return error(res, "title is required");
        if (!body.type) return error(res, "type is required");

        const id = (body.id as string) ?? randomUUID();
        const now = new Date().toISOString();

        db.insert(projects).values({
          id,
          title: body.title as string,
          type: body.type as string,
          notes: body.notes as string ?? null,
          archived: false,
          repoPath: body.repo_path as string ?? null,
          githubRepo: body.github_repo as string ?? null,
          tracking: body.tracking as string ?? null,
          createdAt: now,
          updatedAt: now,
        }).run();

        const created = db.select().from(projects).where(eq(projects.id, id)).get();
        json(res, created, 201);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET/PATCH/DELETE /paw/api/projects/:id
  api.registerHttpRoute({
    path: "/paw/api/projects/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/projects\/([^/?]+)/);
      if (!match) return error(res, "Project ID required", 400);
      const projectId = match[1];

      const db = getDb();

      if (req.method === "GET") {
        const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!row) return error(res, "Not found", 404);
        json(res, row);
      } else if (req.method === "PATCH") {
        const body = await parseBody(req) as Record<string, unknown>;
        const now = new Date().toISOString();
        const update: Record<string, unknown> = { updatedAt: now };

        const fieldMap: Record<string, string> = {
          title: "title", notes: "notes", type: "type", archived: "archived",
          sort_order: "sortOrder", tracking: "tracking", repo_path: "repoPath",
          github_repo: "githubRepo", github_label_filter: "githubLabelFilter",
        };
        for (const [k, v] of Object.entries(fieldMap)) {
          if (k in body) update[v] = body[k];
        }

        db.update(projects).set(update).where(eq(projects.id, projectId)).run();
        const updated = db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!updated) return error(res, "Not found", 404);
        json(res, updated);
      } else if (req.method === "DELETE") {
        db.delete(projects).where(eq(projects.id, projectId)).run();
        json(res, { deleted: true });
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });
}
