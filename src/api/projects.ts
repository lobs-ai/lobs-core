import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { projects } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export async function handleProjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2];

  if (id) {
    // Sub-routes
    if (sub === "archive" && req.method === "POST") {
      db.update(projects).set({ archived: true, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
      return json(res, db.select().from(projects).where(eq(projects.id, id)).get());
    }
    if (sub === "unarchive" && req.method === "POST") {
      db.update(projects).set({ archived: false, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
      return json(res, db.select().from(projects).where(eq(projects.id, id)).get());
    }
    if (sub === "readme" && req.method === "GET") {
      const project = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!project) return error(res, "Not found", 404);
      const repoPath = project.repoPath;
      if (repoPath) {
        for (const name of ["README.md", "readme.md", "README.txt"]) {
          const p = join(repoPath, name);
          if (existsSync(p)) {
            return json(res, { content: readFileSync(p, "utf-8") });
          }
        }
      }
      return json(res, { content: null });
    }
    if (sub === "github-sync" && req.method === "POST") {
      // Stub — actual sync would be handled by the github integration
      return json(res, { status: "queued", message: "GitHub sync queued" });
    }

    if (req.method === "GET") {
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, row);
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const map: Record<string, string> = {
        title: "title", notes: "notes", type: "type", archived: "archived",
        sort_order: "sortOrder", repo_path: "repoPath", github_repo: "githubRepo",
        compliance_required: "complianceRequired",
      };
      for (const [k, v] of Object.entries(map)) { if (k in body) update[v] = body[k]; }
      db.update(projects).set(update).where(eq(projects.id, id)).run();
      return json(res, db.select().from(projects).where(eq(projects.id, id)).get());
    }
    if (req.method === "DELETE") {
      db.delete(projects).where(eq(projects.id, id)).run();
      return json(res, { deleted: true });
    }
    return error(res, "Method not allowed", 405);
  }

  if (req.method === "GET") {
    const q = parseQuery(req.url ?? "");
    const rows = q.archived === "true"
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.archived, false)).orderBy(desc(projects.updatedAt)).all();
    return json(res, rows);
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title || !body.type) return error(res, "title and type required");
    const pid = (body.id as string) ?? randomUUID();
    const now = new Date().toISOString();
    db.insert(projects).values({
      id: pid,
      title: body.title as string,
      type: body.type as string,
      notes: (body.notes as string) ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return json(res, db.select().from(projects).where(eq(projects.id, pid)).get(), 201);
  }
  return error(res, "Method not allowed", 405);
}
