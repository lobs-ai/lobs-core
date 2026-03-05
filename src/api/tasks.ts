/**
 * Task CRUD — handles /api/tasks and /api/tasks/:id and sub-routes
 */

import { randomUUID } from "node:crypto";
import { inferProjectId } from "../util/project-inference.js";
import { eq, and, inArray, desc, lte } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";
import { readFileSync as _readFileSync } from "node:fs";

// ── Brain Dump Gateway helpers ──────────────────────────────────────────

function _brainDumpGatewayCfg(): { port: number; token: string } {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  try {
    const cfg = JSON.parse(_readFileSync(cfgPath, "utf8"));
    return { port: cfg?.gateway?.port ?? 18789, token: cfg?.gateway?.auth?.token ?? "" };
  } catch { return { port: 18789, token: "" }; }
}

async function _brainDumpInvoke(tool: string, args: Record<string, unknown>): Promise<any> {
  const { port, token } = _brainDumpGatewayCfg();
  if (!token) throw new Error("No gateway auth token configured");
  const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ tool, args, sessionKey: "agent:sink:paw-orchestrator-v2" }),
  });
  if (!r.ok) throw new Error(`Gateway ${tool} failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

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


  // /api/tasks/braindump — POST: parse brain dump text, return proposed tasks
  if (id === "braindump" && req.method === "POST") {
    const body = await parseBody(req) as { text?: string; project_id?: string; model_tier_override?: string };
    if (!body.text?.trim()) return error(res, "text is required");

    const systemPrompt = `You are a task extraction assistant. Given freeform text, extract discrete actionable tasks.
For each task assign:
- title: concise, action-oriented title
- agent: one of programmer/writer/researcher/reviewer/architect (pick best fit based on task nature)
- model_tier: one of micro/small/medium/standard/strong (complexity-based: micro=trivial, strong=complex/uncertain)
- notes: 1-3 sentences of clear context for the agent executing it

Return ONLY valid JSON in this exact format with no other text:
{"proposed_tasks": [{"title": "...", "agent": "...", "model_tier": "...", "notes": "..."}]}`;

    const userPrompt = `Extract actionable tasks from this text:

${body.text}`;

    const result = await _brainDumpInvoke("sessions_spawn", {
      task: userPrompt,
      system: systemPrompt,
      model: body.model_tier_override
        ? (body.model_tier_override === "micro" ? "anthropic/claude-haiku-4-5" : "anthropic/claude-haiku-4-5")
        : "anthropic/claude-haiku-4-5",
      mode: "run",
      cleanup: "kill",
      runTimeoutSeconds: 60,
      maxTokens: 2000,
    });

    const rawReply: string = result?.reply ?? result?.response ?? result?.text ?? "";
    // Extract JSON from reply (handle markdown code blocks)
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return error(res, "LLM did not return valid JSON. Reply: " + rawReply.slice(0, 200), 500);
    const parsed = JSON.parse(jsonMatch[0]);
    return json(res, { proposed_tasks: parsed.proposed_tasks ?? [] });
  }

  // /api/tasks/braindump/confirm — POST: bulk-create proposed tasks
  if (id === "braindump" && parts[2] === "confirm" && req.method === "POST") {
    const body = await parseBody(req) as { tasks?: Array<{ title: string; agent?: string; model_tier?: string; notes?: string; project_id?: string }> };
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) return error(res, "tasks array is required");
    const db = getDb();
    const now = new Date().toISOString();
    const created = [];
    for (const t of body.tasks) {
      if (!t.title?.trim()) continue;
      const taskId = randomUUID();
      db.insert(tasks).values({
        id: taskId,
        title: t.title,
        status: "active",
        projectId: t.project_id || inferProjectId(t.title, t.notes),
        notes: t.notes,
        agent: t.agent,
        modelTier: t.model_tier ?? "standard",
        createdAt: now,
        updatedAt: now,
      }).run();
      created.push(db.select().from(tasks).where(eq(tasks.id, taskId)).get());
    }
    return json(res, { created }, 201);
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
      status: (body.status as string) ?? "active",
      owner: body.owner as string,
      projectId: (body.project_id as string) || inferProjectId(body.title as string, body.notes as string | null),
      notes: body.notes as string,
      agent: body.agent as string,
      modelTier: (body.model_tier as string) ?? "standard",
      createdAt: now,
      updatedAt: now,
    }).run();
    const created = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return json(res, created, 201);
  }
  return error(res, "Method not allowed", 405);
}
