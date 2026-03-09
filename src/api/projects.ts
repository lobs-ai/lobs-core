import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { projects, textDumps } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/logger.js";
import { getGatewayConfig } from "../orchestrator/control-loop.js";

// ── Gateway helpers ───────────────────────────────────────────────────────────

async function gatewayInvoke(tool: string, args: Record<string, unknown>): Promise<any> {
  const { port, token } = getGatewayConfig();
  if (!token) throw new Error("No gateway auth token configured");
  const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) throw new Error(`Gateway ${tool} failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw project row from Drizzle by adding a `compliant` boolean
 * alias for `complianceRequired` so the Nexus UI can use a consistent field name.
 */
function normalizeProject(row: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    ...row,
    compliant: Boolean(row["complianceRequired"] ?? row["compliance_required"]),
  };
}

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
      return json(res, normalizeProject(db.select().from(projects).where(eq(projects.id, id)).get() as Record<string, unknown>));
    }
    if (sub === "unarchive" && req.method === "POST") {
      db.update(projects).set({ archived: false, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
      return json(res, normalizeProject(db.select().from(projects).where(eq(projects.id, id)).get() as Record<string, unknown>));
    }
    // PATCH /api/projects/:id/compliance — toggle compliance mode
    // Accepts { compliant: boolean } (Nexus UI convention) as well as { compliance_required: boolean }
    if (sub === "compliance" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      // Support both { compliant: boolean } (Nexus) and { compliance_required: boolean } (raw)
      const rawVal = "compliant" in body ? body["compliant"] : body["compliance_required"];
      if (typeof rawVal !== "boolean") return error(res, "compliant (boolean) is required", 400);
      const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      db.update(projects).set({ complianceRequired: rawVal, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
      return json(res, normalizeProject(db.select().from(projects).where(eq(projects.id, id)).get() as Record<string, unknown>));
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

    // POST /api/projects/:id/braindump — brain dump raw text, spawn agent to parse into tasks
    if (sub === "braindump" && req.method === "POST") {
      const project = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!project) return error(res, "Project not found", 404);

      const body = await parseBody(req) as Record<string, unknown>;
      const rawText = body.text as string;
      if (!rawText || rawText.trim().length === 0) return error(res, "text is required", 400);

      // Save the raw dump for reference
      const dumpId = randomUUID();
      const now = new Date().toISOString();
      db.insert(textDumps).values({
        id: dumpId,
        text: rawText,
        projectId: id,
        status: "processing",
        createdAt: now,
        updatedAt: now,
      }).run();

      // Spawn a sub-agent to parse the brain dump into tasks
      const projectTitle = (project as any).title ?? id;
      const prompt = `[BRAINDUMP] Process this brain dump into PAW tasks for project "${projectTitle}" (project_id: ${id}).

## Instructions
Parse the following raw text into individual, actionable tasks. For each task:
1. Determine a clear, concise title
2. Pick the right agent type (programmer, writer, researcher, architect, reviewer)
3. Pick a model tier (micro for trivial, small/medium for moderate, standard for real work, strong for complex architecture)
4. Write structured notes with Problem, Acceptance Criteria, and Context sections
5. Insert each task into the PAW DB using sqlite3

Use this INSERT template for each task:
\`\`\`
sqlite3 ~/.openclaw/plugins/paw/paw.db "INSERT INTO tasks (id, title, status, agent, model_tier, notes, project_id, created_at, updated_at) VALUES (lower(hex(randomblob(16))), '<title>', 'active', '<agent>', '<tier>', '<notes>', '${id}', datetime('now'), datetime('now'));"
\`\`\`

Important rules:
- Split large items into multiple focused tasks (one concern per task)
- Architect tasks are DESIGN ONLY (specs, ADRs) — never implementation
- If something needs both design and implementation, create TWO tasks
- Skip anything too vague to be actionable — note what you skipped and why
- After creating all tasks, reply with a summary of what was created

## Raw Brain Dump
${rawText}`;

      try {
        await gatewayInvoke("sessions_spawn", {
          task: prompt,
          mode: "run",
          model: "anthropic/claude-sonnet-4-6",
          runTimeoutSeconds: 300,
          cleanup: "keep",
        });
        log().info(`[BRAINDUMP] Spawned agent for project ${id} (dump ${dumpId.slice(0, 8)})`);
      } catch (e) {
        log().error(`[BRAINDUMP] Failed to spawn agent: ${e}`);
        db.update(textDumps).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(textDumps.id, dumpId)).run();
        return error(res, `Failed to spawn processing agent: ${String(e)}`, 500);
      }

      return json(res, { id: dumpId, status: "processing", project_id: id, message: `Brain dump received. Processing into tasks for ${projectTitle}.` }, 202);
    }

    if (req.method === "GET") {
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, normalizeProject(row as Record<string, unknown>));
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const map: Record<string, string> = {
        title: "title", notes: "notes", type: "type", archived: "archived",
        sort_order: "sortOrder", repo_path: "repoPath", github_repo: "githubRepo",
        compliance_required: "complianceRequired",
        // Also accept the Nexus UI convention
        compliant: "complianceRequired",
      };
      for (const [k, v] of Object.entries(map)) { if (k in body) update[v] = body[k]; }
      db.update(projects).set(update).where(eq(projects.id, id)).run();
      return json(res, normalizeProject(db.select().from(projects).where(eq(projects.id, id)).get() as Record<string, unknown>));
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
    return json(res, (rows as Record<string, unknown>[]).map(normalizeProject));
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title || !body.type) return error(res, "title and type required");
    const pid = (body.id as string) ?? randomUUID();
    const now = new Date().toISOString();
    // Support compliance_required or compliant on creation
    const complianceRequired = Boolean(body.compliance_required ?? body.compliant ?? false);
    db.insert(projects).values({
      id: pid,
      title: body.title as string,
      type: body.type as string,
      notes: (body.notes as string) ?? null,
      complianceRequired,
      createdAt: now,
      updatedAt: now,
    }).run();
    return json(res, normalizeProject(db.select().from(projects).where(eq(projects.id, pid)).get() as Record<string, unknown>), 201);
  }
  return error(res, "Method not allowed", 405);
}
